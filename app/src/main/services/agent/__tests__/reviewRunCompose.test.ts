import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../sessionStore'
import { composeReviewRunPrompt, type ComposeReviewRunPromptDeps } from '../reviewRunCompose'
import type { AgentDriver, DriverSession } from '../driver'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'
import type { SubagentSupport } from '../../../../shared/drivers'
import type { PrBinding } from '../../../../shared/pr'
import type { ReviewRunComposition } from '../../../../shared/reviewCompose'

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

const binding: PrBinding = {
  id: 1,
  caseId: 1,
  repoPath: '/repo',
  owner: 'o',
  repo: 'r',
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  source: 'manual',
  detectedAt: '2026-01-01T00:00:00.000Z'
}

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-compose-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'COMPOSE-1', title: 'compose' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function baseDeps(overrides: Partial<ComposeReviewRunPromptDeps> = {}): ComposeReviewRunPromptDeps {
  return {
    db,
    getBinding: () => binding,
    materialize: async () => '/wt/o-r-pr7',
    resolveDriver: () => stubDriver('promptable'),
    ...overrides
  }
}

/** The composed text, failing loudly if the composer reported a blocker instead. */
function promptOf(result: ReviewRunComposition): string {
  if (!result.ok) throw new Error(`expected a composed prompt, got blocker: ${result.reason}`)
  return result.prompt
}

describe('composeReviewRunPrompt', () => {
  it('rejects an unknown review layer before touching bindings', async () => {
    const s = createSession(db, 'COMPOSE-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    await expect(
      composeReviewRunPrompt(baseDeps(), 'COMPOSE-1', s.id, ['not-a-real-layer'])
    ).rejects.toThrow(/Unknown review layer/)
  })

  // A case with nothing bound yet is an ordinary, recoverable state — the user simply has not
  // linked a PR — not a fault. It must NOT be a throw: Electron's invoke re-wrap destroys the
  // error's class and any custom code (see shared/ipcError.ts), so a thrown blocker is only
  // recognisable in the renderer by matching its English sentence. A typed result crosses the
  // IPC boundary intact, which is what lets ReviewRunButton offer "link a PR" instead of
  // painting a red error over the transcript. Same shape the findings write actions already
  // use (`postFindingComment` -> {ok:false, reason}).
  it('reports no-pr-bound as a typed result rather than throwing', async () => {
    const s = createSession(db, 'COMPOSE-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    const result = await composeReviewRunPrompt(
      baseDeps({ getBinding: () => null }),
      'COMPOSE-1',
      s.id,
      []
    )
    expect(result).toEqual({ ok: false, reason: 'no-pr-bound' })
  })

  // The blocker is a report, not an escape hatch: it must be decided before any side-effecting
  // work, exactly like the throw it replaces (materialize creates a worktree on disk).
  it('does not materialize a worktree when nothing is bound', async () => {
    const s = createSession(db, 'COMPOSE-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    let materialized = 0
    await composeReviewRunPrompt(
      baseDeps({
        getBinding: () => null,
        materialize: async () => {
          materialized += 1
          return '/wt/o-r-pr7'
        }
      }),
      'COMPOSE-1',
      s.id,
      []
    )
    expect(materialized).toBe(0)
  })

  // Ownership/validation failures stay throws — they are faults, not states a user can resolve
  // by linking something, and the blocker union must not quietly swallow them.
  it('still throws for a bound PR with no linked local repo', async () => {
    const s = createSession(db, 'COMPOSE-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    await expect(
      composeReviewRunPrompt(baseDeps({ materialize: async () => null }), 'COMPOSE-1', s.id, [])
    ).rejects.toThrow(/no linked local repo/)
  })

  // Finding 2 of the layered-review review: a session with a null instance_id (the documented
  // steady state for an unpinned session, not a corrupt row) must be framed off the driver it
  // ACTUALLY runs on — the live default, exactly like AgentService resolves it — not silently
  // downgraded to 'promptable' just because instance_id is null.
  it('frames an unpinned (null instance_id) review-mode session off the live default driver', async () => {
    const s = createSession(db, 'COMPOSE-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    const p = promptOf(
      await composeReviewRunPrompt(
        baseDeps({ resolveDriver: () => stubDriver('configurable') }),
        'COMPOSE-1',
        s.id,
        []
      )
    )
    expect(p).toContain('review-correctness')
    // Discriminates configurable framing from promptable framing (the layer menu names every
    // agent unconditionally, so `toContain('review-correctness')` alone passes under either
    // framing — see reviewRunCompose.test.ts:135's same discriminator, inverted here): only the
    // configurable fan-out text extends the by-name delegation invite, and only the promptable
    // path inlines a layer's own task text (e.g. correctness's "chase every suspicion") into
    // this turn.
    expect(p).toMatch(/subagent you can delegate to by name/i)
    expect(p).not.toContain('chase every suspicion')
  })

  it('frames a pinned-instance review-mode session off ITS instance driver, not the default', async () => {
    const s = createSession(db, 'COMPOSE-1', {
      driverKind: 'github-copilot',
      instanceId: 'copilot-1',
      mode: 'review'
    })
    const seenInstances: string[] = []
    const p = promptOf(
      await composeReviewRunPrompt(
        baseDeps({
          // The live default is promptable; the pinned instance is configurable. If the composer
          // fell back to the default (finding 2's bug) this would come back inlined.
          resolveDriver: () => stubDriver('promptable'),
          driverForInstance: (id) => {
            seenInstances.push(id)
            return stubDriver('configurable')
          }
        }),
        'COMPOSE-1',
        s.id,
        []
      )
    )
    expect(seenInstances).toEqual(['copilot-1'])
    expect(p).toContain('review-correctness')
  })

  it('inlines the layer bodies (without the delegate contract) for a promptable driver', async () => {
    const s = createSession(db, 'COMPOSE-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    const p = promptOf(
      await composeReviewRunPrompt(
        baseDeps({ resolveDriver: () => stubDriver('promptable') }),
        'COMPOSE-1',
        s.id,
        []
      )
    )
    expect(p).not.toMatch(/subagent you can delegate to by name/i)
    expect(p).toContain('chase every suspicion')
    expect(p).not.toMatch(/no findings tool/i)
  })

  // Finding 3: nothing verified the session belonged to the case it was passed.
  it('rejects a sessionId that belongs to a different case', async () => {
    createCase(db, argusHome, { slug: 'COMPOSE-2', title: 'other' })
    const other = createSession(db, 'COMPOSE-2', { driverKind: 'claude-agent-sdk', mode: 'review' })
    await expect(composeReviewRunPrompt(baseDeps(), 'COMPOSE-1', other.id, [])).rejects.toThrow(
      /Unknown session/
    )
  })
})
