import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { searchPrsForCase, type Runner } from '../prSearch'

let db: DatabaseSync
let home: string

const GH_JSON = JSON.stringify([
  {
    number: 16315,
    state: 'merged',
    isDraft: false,
    title: '[NN-5165] Fix alternatives fork-passed check',
    createdAt: '2026-07-21T10:47:23Z',
    url: 'https://github.com/JiaweiHan88/HiveMindTest/pull/16315',
    repository: { nameWithOwner: 'JiaweiHan88/HiveMindTest' }
  }
])

const linkRepo = (slug: string, remote: string | null, p = '/tmp/HiveMindTest'): void => {
  db.prepare(`UPDATE cases SET workspaces = ? WHERE slug = ?`).run(
    JSON.stringify([{ path: p, remote, branch: 'main' }]),
    slug
  )
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prsearch-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1', jiraKey: 'NN-5165' })
})

describe('searchPrsForCase', () => {
  it('searches the linked repo and classifies the result', async () => {
    linkRepo('c1', 'git@github.com:JiaweiHan88/HiveMindTest.git')
    let seen: string[] = []
    const gh: Runner = async (_cmd, args) => {
      seen = args
      return GH_JSON
    }
    const r = await searchPrsForCase({ db, gh }, 'c1')
    expect(r.error).toBeNull()
    expect(r.candidates.map((c) => c.number)).toEqual([16315])
    expect(r.searchedRepos).toEqual(['JiaweiHan88/HiveMindTest'])
    expect(seen).toContain('NN-5165')
    expect(seen).toContain('--repo')
    expect(seen).toContain('JiaweiHan88/HiveMindTest')
    expect(seen).toContain('--match')
    expect(seen).toContain('title')
  })

  it('passes one --repo per linked GitHub repo in a single invocation', async () => {
    db.prepare(`UPDATE cases SET workspaces = ? WHERE slug = ?`).run(
      JSON.stringify([
        { path: '/tmp/a', remote: 'git@github.com:JiaweiHan88/a.git', branch: 'main' },
        { path: '/tmp/b', remote: 'https://github.com/JiaweiHan88/b.git', branch: 'main' }
      ]),
      'c1'
    )
    let calls = 0
    let seen: string[] = []
    const gh: Runner = async (_c, args) => {
      calls++
      seen = args
      return '[]'
    }
    const r = await searchPrsForCase({ db, gh }, 'c1')
    expect(calls).toBe(1)
    expect(seen.filter((a) => a === '--repo')).toHaveLength(2)
    expect(r.searchedRepos).toEqual(['JiaweiHan88/a', 'JiaweiHan88/b'])
  })

  it('skips the search when the case has no jira key', async () => {
    createCase(db, home, { slug: 'c2', title: 'No ticket' })
    linkRepo('c2', 'git@github.com:JiaweiHan88/HiveMindTest.git')
    let called = false
    const gh: Runner = async () => {
      called = true
      return GH_JSON
    }
    const r = await searchPrsForCase({ db, gh }, 'c2')
    expect(called).toBe(false)
    expect(r).toEqual({ candidates: [], error: null, searchedRepos: [] })
  })

  it('filters out non-GitHub remotes and reports no searchable repo', async () => {
    linkRepo('c1', 'git@gitlab.com:JiaweiHan88/x.git')
    let called = false
    const gh: Runner = async () => {
      called = true
      return GH_JSON
    }
    const r = await searchPrsForCase({ db, gh }, 'c1')
    expect(called).toBe(false)
    expect(r.candidates).toEqual([])
    expect(r.searchedRepos).toEqual([])
  })

  it('reports gh not installed instead of throwing', async () => {
    linkRepo('c1', 'git@github.com:JiaweiHan88/HiveMindTest.git')
    const gh: Runner = async () => {
      const err = new Error('spawn gh ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    const r = await searchPrsForCase({ db, gh }, 'c1')
    expect(r.error).toMatch(/not installed/i)
    expect(r.candidates).toEqual([])
  })

  it('reports malformed JSON instead of throwing', async () => {
    linkRepo('c1', 'git@github.com:JiaweiHan88/HiveMindTest.git')
    const gh: Runner = async () => 'not json at all'
    const r = await searchPrsForCase({ db, gh }, 'c1')
    expect(r.error).toBeTruthy()
    expect(r.candidates).toEqual([])
  })

  it('returns an empty, error-free result when nothing matches', async () => {
    linkRepo('c1', 'git@github.com:JiaweiHan88/HiveMindTest.git')
    const gh: Runner = async () => '[]'
    const r = await searchPrsForCase({ db, gh }, 'c1')
    expect(r).toEqual({
      candidates: [],
      error: null,
      searchedRepos: ['JiaweiHan88/HiveMindTest']
    })
  })
})
