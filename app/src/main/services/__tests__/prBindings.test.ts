import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { addBinding, listBindings, removeBinding, bindingCount } from '../prBindings'
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

  it('supports several PRs per case and removal', () => {
    addBinding(db, 'c1', PR)
    const second = addBinding(db, 'c1', {
      ...PR,
      number: 43,
      url: 'https://github.com/acme/widget/pull/43'
    })
    expect(listBindings(db, 'c1')).toHaveLength(2)
    removeBinding(db, 'c1', second.id)
    expect(listBindings(db, 'c1').map((b) => b.number)).toEqual([42])
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
