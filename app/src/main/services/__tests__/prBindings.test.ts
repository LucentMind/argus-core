import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { addBinding, getBinding, listBindings, removeBinding, bindingCount } from '../prBindings'
import { modeContextForCase } from '../modeContext'
import { availableModes } from '../../../shared/modes'

let db: DatabaseSync
let home: string

const PR = {
  repoPath: null,
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
  source: 'manual' as const
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pr-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
})

describe('pr bindings', () => {
  it('starts empty', () => {
    expect(listBindings(db, 'c1')).toEqual([])
    expect(bindingCount(db, 'c1')).toBe(0)
  })

  it('is idempotent on (owner, repo, number)', () => {
    const a = addBinding(db, 'c1', PR)
    const b = addBinding(db, 'c1', { ...PR, source: 'search' })
    expect(b.id).toBe(a.id)
    expect(listBindings(db, 'c1')).toHaveLength(1)
  })

  it('supports binding and removal', () => {
    const bound = addBinding(db, 'c1', PR)
    expect(listBindings(db, 'c1')).toHaveLength(1)
    removeBinding(db, 'c1', bound.id)
    expect(listBindings(db, 'c1')).toEqual([])
  })

  it('bindings are scoped per case', () => {
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    addBinding(db, 'c1', PR)
    expect(bindingCount(db, 'c2')).toBe(0)
  })

  it('review mode availability tracks LINKED REPOS, not bindings', () => {
    // a case with no linked repo cannot make a worktree, so review stays unavailable
    // even with a bound PR
    addBinding(db, 'c1', PR)
    expect(availableModes(modeContextForCase(db, 'c1'))).toEqual(['investigation'])

    // linking a repo unlocks review, with or without bindings
    db.prepare(`UPDATE cases SET workspaces = ? WHERE slug = ?`).run(
      JSON.stringify([{ path: '/tmp/repo-a', remote: null, branch: 'main' }]),
      'c1'
    )
    expect(modeContextForCase(db, 'c1').linkedRepoCount).toBe(1)
    expect(availableModes(modeContextForCase(db, 'c1'))).toEqual(['investigation', 'review'])
  })

  it('modeContextForCase is total — an unknown slug reports zero repos, never throws', () => {
    expect(modeContextForCase(db, 'nope').linkedRepoCount).toBe(0)
  })
})

describe('one binding per case', () => {
  it('replaces an existing binding rather than accumulating', () => {
    addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const second = addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'widget',
      number: 43,
      url: 'https://github.com/acme/widget/pull/43',
      source: 'manual'
    })
    expect(listBindings(db, 'c1')).toHaveLength(1)
    expect(listBindings(db, 'c1')[0].number).toBe(43)
    expect(getBinding(db, 'c1')?.id).toBe(second.id)
  })

  it('re-adding the same PR is idempotent and keeps its identity', () => {
    const first = addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const again = addBinding(db, 'c1', {
      repoPath: '/clones/widget',
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    expect(again.id).toBe(first.id)
    expect(listBindings(db, 'c1')).toHaveLength(1)
  })

  it('binds each case independently', () => {
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    addBinding(db, 'c2', {
      repoPath: null,
      owner: 'acme',
      repo: 'gadget',
      number: 7,
      url: 'https://github.com/acme/gadget/pull/7',
      source: 'manual'
    })
    expect(getBinding(db, 'c1')?.number).toBe(42)
    expect(getBinding(db, 'c2')?.number).toBe(7)
  })

  it('getBinding returns null for a case with no PR', () => {
    expect(getBinding(db, 'c1')).toBeNull()
  })

  it('migrates a database that already has several bindings on one case', () => {
    // Build the pre-migration state directly: openDb's own index would reject it.
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prmigrate-'))
    const file = path.join(home2, 'argus.db')
    const first = openDb(file)
    createCase(first, home2, { slug: 'c1', title: 'Case 1' })
    const caseId = (first.prepare(`SELECT id FROM cases WHERE slug = 'c1'`).get() as { id: number })
      .id
    first.exec(`DROP INDEX IF EXISTS pr_bindings_one_per_case`)
    for (const n of [42, 43, 44]) {
      first
        .prepare(
          `INSERT INTO pr_bindings (case_id, repo_path, owner, repo, number, url, source, detected_at)
           VALUES (?, NULL, 'acme', 'widget', ?, ?, 'search', ?)`
        )
        .run(caseId, n, `https://github.com/acme/widget/pull/${n}`, new Date().toISOString())
    }
    expect(first.prepare(`SELECT COUNT(*) AS n FROM pr_bindings`).get()).toEqual({ n: 3 })
    first.close()

    const reopened = openDb(file) // runs the migration
    expect(reopened.prepare(`SELECT COUNT(*) AS n FROM pr_bindings`).get()).toEqual({ n: 1 })
    expect(getBinding(reopened, 'c1')?.number).toBe(44) // newest kept
    reopened.close()
  })
})
