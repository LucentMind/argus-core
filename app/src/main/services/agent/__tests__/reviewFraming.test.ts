import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createSession } from '../sessionStore'
import {
  reviewSubagentSupport,
  driverForSession,
  resolveReviewFraming,
  sessionHistoryOrphaned,
  type SessionDriverDeps
} from '../reviewFraming'
import type { AgentDriver, DriverSession } from '../driver'
import { CLAUDE_TOOL_TAXONOMY } from '../risk'
import { PERMISSION_MODES } from '../../../../shared/settings'
import type { SubagentSupport } from '../../../../shared/drivers'

function stubDriver(kind: string, subagents: SubagentSupport): AgentDriver {
  return {
    kind: kind as AgentDriver['kind'],
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

describe('reviewSubagentSupport', () => {
  it('is configurable only when both review mode and a configurable driver hold', () => {
    expect(reviewSubagentSupport('review', 'configurable')).toBe('configurable')
  })

  it('degrades to promptable outside review mode even on a configurable driver', () => {
    expect(reviewSubagentSupport('investigation', 'configurable')).toBe('promptable')
  })

  it('degrades to promptable in review mode on a promptable driver', () => {
    expect(reviewSubagentSupport('review', 'promptable')).toBe('promptable')
  })
})

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-framing-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'FRAME-1', title: 'framing' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('driverForSession', () => {
  it('resolves a pinned session through driverForInstance', () => {
    const s = createSession(db, 'FRAME-1', {
      driverKind: 'github-copilot',
      instanceId: 'copilot-1'
    })
    const seen: string[] = []
    const driver = driverForSession(
      {
        db,
        driverForInstance: (id) => {
          seen.push(id)
          return stubDriver('github-copilot', 'configurable')
        },
        resolveDriver: () => stubDriver('claude-agent-sdk', 'promptable')
      },
      s.id
    )
    expect(seen).toEqual(['copilot-1'])
    expect(driver.kind).toBe('github-copilot')
  })

  it('falls back to the live default provider for an unpinned session (null instance_id)', () => {
    const s = createSession(db, 'FRAME-1', 'claude-agent-sdk')
    const driver = driverForSession(
      {
        db,
        driverForInstance: () => stubDriver('github-copilot', 'configurable'),
        resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable')
      },
      s.id
    )
    expect(driver.kind).toBe('claude-agent-sdk')
  })
})

describe('resolveReviewFraming', () => {
  it('throws on an unknown case', () => {
    expect(() =>
      resolveReviewFraming(
        { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
        'NO-SUCH-CASE',
        1
      )
    ).toThrow(/Unknown case/)
  })

  it('throws when the session does not belong to caseSlug', () => {
    createCase(db, argusHome, { slug: 'FRAME-2', title: 'other' })
    const s = createSession(db, 'FRAME-2', 'claude-agent-sdk')
    expect(() =>
      resolveReviewFraming(
        { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
        'FRAME-1',
        s.id
      )
    ).toThrow(/Unknown session/)
  })

  it('frames configurable for a review-mode session on a configurable driver', () => {
    const s = createSession(db, 'FRAME-1', { driverKind: 'claude-agent-sdk', mode: 'review' })
    const framing = resolveReviewFraming(
      { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
      'FRAME-1',
      s.id
    )
    expect(framing).toEqual({ support: 'configurable' })
  })

  it('frames promptable for an investigation-mode session even on a configurable driver', () => {
    const s = createSession(db, 'FRAME-1', {
      driverKind: 'claude-agent-sdk',
      mode: 'investigation'
    })
    const framing = resolveReviewFraming(
      { db, resolveDriver: () => stubDriver('claude-agent-sdk', 'configurable') },
      'FRAME-1',
      s.id
    )
    expect(framing.support).toBe('promptable')
  })
})

describe('sessionHistoryOrphaned', () => {
  const claude = { kind: 'claude-agent-sdk' } as never
  const copilot = { kind: 'github-copilot' } as never
  const deps = (db: DatabaseSync, driver = claude): SessionDriverDeps =>
    ({ db, resolveDriver: () => driver, driverForInstance: () => driver }) as never

  function seed(
    db: DatabaseSync,
    row: {
      turns: number
      cursor: string | null
      kind: string
      instance: string | null
      /** Who PRODUCED `cursor` — defaults to null (the legacy/pre-column shape: a row whose
       *  cursor predates `cursor_instance_id`, matched on driver kind alone). Pass this
       *  explicitly to seed a row the way `setSessionCursor` actually writes one in
       *  production, with an independent owner distinct from the CURRENT pin (`instance`). */
      cursorInstance?: string | null
    }
  ): number {
    const now = new Date().toISOString()
    const r = db
      .prepare(
        `INSERT INTO sessions (case_id, title, turn_count, driver_cursor, driver_kind, instance_id, cursor_instance_id, created_at, updated_at)
         VALUES (1, '', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.turns, row.cursor, row.kind, row.instance, row.cursorInstance ?? null, now, now)
    return Number(r.lastInsertRowid)
  }

  it('is false for a healthy session with a matching cursor', () => {
    const id = seed(db, { turns: 3, cursor: 'abc', kind: 'claude-agent-sdk', instance: null })
    expect(sessionHistoryOrphaned(deps(db), id)).toBe(false)
  })

  it('is true for a freshly imported session (history, no cursor)', () => {
    const id = seed(db, { turns: 3, cursor: null, kind: 'claude-agent-sdk', instance: null })
    expect(sessionHistoryOrphaned(deps(db), id)).toBe(true)
  })

  it('is true after a driver-kind switch', () => {
    const id = seed(db, { turns: 3, cursor: 'abc', kind: 'claude-agent-sdk', instance: null })
    expect(sessionHistoryOrphaned(deps(db, copilot), id)).toBe(true)
  })

  it('is false for an instance-pinned session whose cursor predates cursor_instance_id (legacy null owner)', () => {
    // No `cursorInstance` given — this is the pre-migration shape: a cursor written before
    // the ownership column existed. `sessionCursor` matches these on driver kind alone
    // (sessionStore.ts), so an instance pin alone does not orphan the history.
    const id = seed(db, { turns: 3, cursor: 'abc', kind: 'claude-agent-sdk', instance: 'inst-a' })
    expect(sessionHistoryOrphaned(deps(db), id)).toBe(false)
  })

  it('is false when re-pinned back to the instance that actually produced the cursor', () => {
    const id = seed(db, {
      turns: 3,
      cursor: 'abc',
      kind: 'claude-agent-sdk',
      instance: 'inst-a',
      cursorInstance: 'inst-a'
    })
    expect(sessionHistoryOrphaned(deps(db), id)).toBe(false)
  })

  it('is true after a same-kind instance switch away from the cursor owner (path 4)', () => {
    // The cursor was produced by inst-a (cursorInstance), but the row is now pinned to
    // inst-b. Before cursor_instance_id existed, sessionCursor's instance guard compared
    // instance_id against itself and could never observe this — see sessionStore.ts's
    // sessionCursor doc comment. It now correctly flags the history as orphaned.
    const id = seed(db, {
      turns: 3,
      cursor: 'abc',
      kind: 'claude-agent-sdk',
      instance: 'inst-b',
      cursorInstance: 'inst-a'
    })
    expect(sessionHistoryOrphaned(deps(db), id)).toBe(true)
  })

  it('is false for a session that has no history to lose', () => {
    const id = seed(db, { turns: 0, cursor: null, kind: 'claude-agent-sdk', instance: null })
    expect(sessionHistoryOrphaned(deps(db), id)).toBe(false)
  })
})
