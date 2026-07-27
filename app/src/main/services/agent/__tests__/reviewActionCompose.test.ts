import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { createSession } from '../sessionStore'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { caseDir } from '../../paths'
import { appendFinding } from '../nativeTools'
import { composeReviewActionPrompt, type ComposeReviewActionDeps } from '../reviewActionCompose'
import type { AgentDriver, DriverSession } from '../driver'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'
import type { SubagentSupport } from '../../../../shared/drivers'

function stubDriver(subagents: SubagentSupport): AgentDriver {
  return {
    kind: 'claude-agent-sdk',
    toolTaxonomy: CLAUDE_TOOL_TAXONOMY,
    authFixHint: 'stub',
    capabilities: {
      permissionModes: PERMISSION_MODES,
      editableApprovals: true,
      costReporting: true,
      headlessOneShot: false,
      systemPromptTransport: 'systemPrompt.append',
      subagents
    },
    createSession(): DriverSession {
      throw new Error('not used in these tests')
    },
    probeAuth: async () => ({ ok: true, detail: '' })
  }
}

let tmp: string, home: string, db: DatabaseSync, repoPath: string, worktree: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-actioncompose-'))
  home = path.join(tmp, 'home')
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  repoPath = path.join(home, 'clones', 'widget')
  fs.mkdirSync(repoPath, { recursive: true })
  addBinding(db, 'c1', {
    repoPath,
    owner: 'acme',
    repo: 'widget',
    number: 42,
    url: 'https://github.com/acme/widget/pull/42',
    source: 'manual'
  })
  worktree = casePrWorktreeDir(home, 'c1', repoPath, 42)
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'src', 'guard.ts'), 'x')
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function baseDeps(overrides: Partial<ComposeReviewActionDeps> = {}): ComposeReviewActionDeps {
  return {
    db,
    argusHome: home,
    resolveDriver: () => stubDriver('promptable'),
    ...overrides
  }
}

/** A review-mode session actually owned by case c1, so resolveReviewFraming's ownership check
 *  passes and the tests reach the guard/composition logic under test. */
function seedSession(): number {
  return createSession(db, 'c1', { driverKind: 'claude-agent-sdk', mode: 'review' }).id
}

/** Written through appendFinding so it lands in BOTH the `findings` row and findings.md's
 *  markdown block — the two sources composeReviewActionPrompt reads from. */
function seedFinding(
  sessionId: number,
  markdown = 'Guard is inverted. See [widget/src/guard.ts:17].'
): number {
  return appendFinding(
    { db, argusHome: home, caseId: getCase(db, 'c1')!.id, caseSlug: 'c1', sessionId, turnId: null },
    { title: 'Inverted guard', markdown, layer: 'correctness', severity: 'major' }
  ).findingId
}

describe('composeReviewActionPrompt', () => {
  it('rejects a sessionId that belongs to a different case, before producing any prompt', async () => {
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    const otherSession = createSession(db, 'c2', {
      driverKind: 'claude-agent-sdk',
      mode: 'review'
    }).id
    const sessionInC1 = seedSession()
    const findingId = seedFinding(sessionInC1)
    await expect(
      composeReviewActionPrompt(baseDeps(), 'c1', otherSession, findingId, 'comment')
    ).rejects.toThrow(/Unknown session/)
  })

  it('rejects a finding id that belongs to a different case, with the unknown-finding text', async () => {
    const sessionId = seedSession()
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    const foreign = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
         VALUES (?, NULL, NULL, 'other', 'pending', ?)`
      )
      .run(getCase(db, 'c2')!.id, new Date().toISOString())
    await expect(
      composeReviewActionPrompt(
        baseDeps(),
        'c1',
        sessionId,
        Number(foreign.lastInsertRowid),
        'comment'
      )
    ).rejects.toThrow(/unknown finding/i)
  })

  it('rejects an unknown action string', async () => {
    const sessionId = seedSession()
    const findingId = seedFinding(sessionId)
    await expect(
      composeReviewActionPrompt(baseDeps(), 'c1', sessionId, findingId, 'delete-everything')
    ).rejects.toThrow(/Unknown review action/)
  })

  it('rejects a non-integer session id', async () => {
    const sessionId = seedSession()
    const findingId = seedFinding(sessionId)
    await expect(
      composeReviewActionPrompt(baseDeps(), 'c1', 1.5, findingId, 'comment')
    ).rejects.toThrow(/Invalid session id/)
  })

  it('rejects a non-integer finding id', async () => {
    const sessionId = seedSession()
    await expect(
      composeReviewActionPrompt(baseDeps(), 'c1', sessionId, 1.5, 'comment')
    ).rejects.toThrow(/Invalid finding id/)
  })

  it('composes the comment turn: summary, PR url and anchor all reach the text', async () => {
    const sessionId = seedSession()
    const findingId = seedFinding(sessionId)
    const p = await composeReviewActionPrompt(baseDeps(), 'c1', sessionId, findingId, 'comment')
    expect(p).toContain('Inverted guard')
    expect(p).toContain('https://github.com/acme/widget/pull/42')
    expect(p).toContain('src/guard.ts:17')
  })

  it('composes the apply turn: summary, PR url, anchor AND the worktree path all reach the text', async () => {
    const sessionId = seedSession()
    const findingId = seedFinding(sessionId)
    const p = await composeReviewActionPrompt(baseDeps(), 'c1', sessionId, findingId, 'apply')
    expect(p).toContain('Inverted guard')
    expect(p).toContain('https://github.com/acme/widget/pull/42')
    expect(p).toContain('src/guard.ts:17')
    expect(p).toContain(worktree)
  })

  it('reads the finding body out of findings.md and it reaches the composed prompt', async () => {
    const sessionId = seedSession()
    const findingId = seedFinding(
      sessionId,
      'Guard is inverted — a UNIQUE-BODY-MARKER sentence only findings.md carries. See [widget/src/guard.ts:17].'
    )
    const p = await composeReviewActionPrompt(baseDeps(), 'c1', sessionId, findingId, 'comment')
    expect(p).toContain('UNIQUE-BODY-MARKER')
  })

  it('still composes (not throws) when findings.md is missing, with the body left blank', async () => {
    const sessionId = seedSession()
    const findingId = seedFinding(
      sessionId,
      'Guard is inverted — a UNIQUE-BODY-MARKER sentence only findings.md carries. See [widget/src/guard.ts:17].'
    )
    // Simulate a missing/unreadable findings.md: appendFinding above wrote it, delete it after.
    fs.rmSync(path.join(caseDir(home, 'c1'), 'findings.md'))
    const p = await composeReviewActionPrompt(baseDeps(), 'c1', sessionId, findingId, 'comment')
    expect(p).toContain('Inverted guard') // summary still present — the row survives
    expect(p).not.toContain('UNIQUE-BODY-MARKER') // the body, sourced only from the deleted file, is not
  })
})
