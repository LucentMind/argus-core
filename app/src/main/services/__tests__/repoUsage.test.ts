import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { autoLinkDefaultRepo, listWorkspaces } from '../workspaces'
import {
  recordLink,
  caseCount,
  listRecent,
  isPromoteDismissed,
  dismissPromote,
  shouldSuggestDefault,
  repoKey,
  assertRepoPath,
  PROMOTE_THRESHOLD
} from '../repoUsage'

let tmp: string, db: DatabaseSync
const A = 'C:\\repos\\alpha'
const B = 'C:\\repos\\beta'
const always = (): boolean => true

/** Fixed clock helper: distinct, ordered ISO stamps without touching the real clock. */
function at(min: number): () => Date {
  return () => new Date(Date.UTC(2026, 7, 3, 12, min, 0))
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-repousage-'))
  db = openDb(path.join(tmp, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('caseCount', () => {
  it('counts distinct cases, not link events', () => {
    recordLink(db, A, 'C-1', at(0))
    recordLink(db, A, 'C-1', at(1))
    recordLink(db, A, 'C-1', at(2))
    expect(caseCount(db, A)).toBe(1)
  })

  it('rises with each new case', () => {
    recordLink(db, A, 'C-1', at(0))
    recordLink(db, A, 'C-2', at(1))
    recordLink(db, A, 'C-3', at(2))
    expect(caseCount(db, A)).toBe(3)
  })

  it('treats a trailing separator as the same repo', () => {
    recordLink(db, A, 'C-1', at(0))
    recordLink(db, `${A}\\`, 'C-2', at(1))
    expect(caseCount(db, A)).toBe(2)
    expect(repoKey(`${A}\\`)).toBe(repoKey(A))
  })

  it('is zero for a repo never linked', () => {
    expect(caseCount(db, A)).toBe(0)
  })
})

describe('listRecent', () => {
  it('orders by most recent link and reports the basename', () => {
    recordLink(db, A, 'C-1', at(0))
    recordLink(db, B, 'C-1', at(1))
    recordLink(db, A, 'C-2', at(2))
    expect(listRecent(db, 10, always)).toEqual([
      { path: repoKey(A), name: 'alpha' },
      { path: repoKey(B), name: 'beta' }
    ])
  })

  it('omits paths that no longer exist without deleting their rows', () => {
    recordLink(db, A, 'C-1', at(0))
    recordLink(db, B, 'C-1', at(1))
    const onlyB = (p: string): boolean => p === repoKey(B)
    expect(listRecent(db, 10, onlyB)).toEqual([{ path: repoKey(B), name: 'beta' }])
    // the row survives, so the repo returns when its drive does
    expect(listRecent(db, 10, always).map((r) => r.name)).toContain('alpha')
  })

  it('honours the limit', () => {
    recordLink(db, A, 'C-1', at(0))
    recordLink(db, B, 'C-1', at(1))
    expect(listRecent(db, 1, always)).toEqual([{ path: repoKey(B), name: 'beta' }])
  })
})

describe('shouldSuggestDefault', () => {
  function linkToCases(n: number): void {
    for (let i = 0; i < n; i++) recordLink(db, A, `C-${i}`, at(i))
  }

  it('is false below the threshold', () => {
    linkToCases(PROMOTE_THRESHOLD - 1)
    expect(shouldSuggestDefault(db, A, [])).toBe(false)
  })

  it('is true at the threshold', () => {
    linkToCases(PROMOTE_THRESHOLD)
    expect(shouldSuggestDefault(db, A, [])).toBe(true)
  })

  it('is false once dismissed, at any count', () => {
    linkToCases(PROMOTE_THRESHOLD + 5)
    dismissPromote(db, A)
    expect(isPromoteDismissed(db, A)).toBe(true)
    expect(shouldSuggestDefault(db, A, [])).toBe(false)
  })

  it('dismissing twice stays dismissed', () => {
    dismissPromote(db, A)
    dismissPromote(db, A)
    expect(isPromoteDismissed(db, A)).toBe(true)
  })

  it('is false for a repo that is already a default, including a differently-spelled path', () => {
    linkToCases(PROMOTE_THRESHOLD)
    expect(shouldSuggestDefault(db, A, [`${A}\\`])).toBe(false)
  })

  it('does not confuse one repo for another', () => {
    linkToCases(PROMOTE_THRESHOLD)
    expect(shouldSuggestDefault(db, B, [])).toBe(false)
  })
})

describe('the auto-link seam', () => {
  it('autoLinkDefaultRepo writes NO repo_usage row', async () => {
    // The load-bearing invariant of this whole feature: auto-links bypass the IPC handler,
    // which is the only place `recordLink` is called. Without this, every default repo would
    // instantly become eligible for a prompt asking it to become one.
    const home = path.join(tmp, 'ArgusHome')
    const repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'c1'], { cwd: repo })

    const db2 = openDb(path.join(home, 'argus.db'))
    createCase(db2, home, { slug: 'C-1', title: 'test' })
    await autoLinkDefaultRepo(db2, home, 'C-1', [repo])

    expect((await listWorkspaces(db2, home, 'C-1')).map((w) => w.path)).toEqual([repo])
    expect(caseCount(db2, repo)).toBe(0)
    db2.close()
  }, 15000)
})

describe('assertRepoPath', () => {
  it('rejects non-strings and blanks', () => {
    expect(() => assertRepoPath(undefined)).toThrow(/Invalid repo path/)
    expect(() => assertRepoPath(42)).toThrow(/Invalid repo path/)
    expect(() => assertRepoPath('   ')).toThrow(/Invalid repo path/)
  })

  it('accepts a real path', () => {
    expect(() => assertRepoPath(A)).not.toThrow()
  })
})
