import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase, setCaseMode } from '../caseService'
import { addBinding, materializePrBindings } from '../prBindings'
import type { PrBinding } from '../../../shared/pr'
import type { SessionProvider } from '../agent/sessionStore'

const PROVIDER: SessionProvider = { driverKind: 'claude', instanceId: null, model: null }

let db: DatabaseSync
let home: string

const claudeMd = (): string => fs.readFileSync(path.join(home, 'cases', 'c1', 'CLAUDE.md'), 'utf8')

const bind = (n: number, repoPath: string | null): PrBinding =>
  addBinding(db, 'c1', {
    repoPath,
    owner: 'acme',
    repo: 'widget',
    number: n,
    url: `https://github.com/acme/widget/pull/${n}`,
    source: 'search'
  })

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-rws-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  // review mode needs a linked repo to be available at all
  db.prepare(`UPDATE cases SET workspaces = ? WHERE slug = ?`).run(
    JSON.stringify([{ path: '/tmp/widget', remote: null, branch: 'main' }]),
    'c1'
  )
})

describe('review working set', () => {
  it('materializes the bound PR when it has a repoPath', async () => {
    bind(42, '/tmp/widget')
    const seen: number[] = []
    await setCaseMode(db, home, 'c1', 'review', PROVIDER, {
      materialize: async (b) => {
        seen.push(b.number)
        return `/wt/widget-c1-pr${b.number}`
      }
    })
    expect(seen).toEqual([42])
  })

  it('never materializes a binding with repoPath: null', async () => {
    bind(43, null)
    const seen: number[] = []
    await setCaseMode(db, home, 'c1', 'review', PROVIDER, {
      materialize: async (b) => {
        seen.push(b.number)
        return `/wt/widget-c1-pr${b.number}`
      }
    })
    expect(seen).toEqual([])
  })

  it('does not materialize when switching to investigation', async () => {
    bind(42, '/tmp/widget')
    let called = false
    await setCaseMode(db, home, 'c1', 'investigation', PROVIDER, {
      materialize: async () => {
        called = true
        return null
      }
    })
    expect(called).toBe(false)
  })

  it('a failing materializer does not block the mode switch', async () => {
    bind(42, '/tmp/widget')
    const { sessionId } = await setCaseMode(db, home, 'c1', 'review', PROVIDER, {
      materialize: async () => {
        throw new Error('git exploded')
      }
    })
    expect(sessionId).toBeGreaterThan(0)
    expect(
      (db.prepare(`SELECT active_mode AS m FROM cases WHERE slug = 'c1'`).get() as { m: string }).m
    ).toBe('review')
  })

  it("writes the bound PR into the case's CLAUDE.md, with the worktree path when materialized", async () => {
    bind(42, '/tmp/widget')
    await setCaseMode(db, home, 'c1', 'review', PROVIDER, {
      materialize: async (b) => `/wt/widget-c1-pr${b.number}`
    })
    const md = claudeMd()
    expect(md).toContain('acme/widget#42')
    expect(md).toContain('/wt/widget-c1-pr42')
  })

  it("writes the bound PR into CLAUDE.md without a worktree path when it isn't materialized", async () => {
    bind(43, null)
    await setCaseMode(db, home, 'c1', 'review', PROVIDER, {
      materialize: async (b) => `/wt/widget-c1-pr${b.number}`
    })
    const md = claudeMd()
    // an unmaterialized binding is still listed — the agent falls back to `gh pr diff`
    expect(md).toContain('acme/widget#43')
    expect(md).not.toContain('/wt/widget-c1-pr43')
  })

  it('materializePrBindings is directly callable with the same contract (the picker path)', async () => {
    bind(42, '/tmp/widget')
    const seen: number[] = []
    await materializePrBindings(db, home, 'c1', async (b) => {
      seen.push(b.number)
      return `/wt/widget-c1-pr${b.number}`
    })
    expect(seen).toEqual([42])
    expect(claudeMd()).toContain('acme/widget#42')
  })
})
