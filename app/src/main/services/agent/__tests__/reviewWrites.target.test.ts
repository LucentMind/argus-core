import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { appendFinding } from '../nativeTools'
import { resolveCommentTarget } from '../reviewWrites'

let db: DatabaseSync
let home: string
let repoPath: string

/** `updated_at` is NOT NULL with no default (db.ts:50) — omitting it fails the insert. */
function seedSession(): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sessions (id, case_id, mode, created_at, updated_at) VALUES (1, ?, 'review', ?, ?)`
  ).run(getCase(db, 'c1')!.id, now, now)
}

function finding(markdown: string): number {
  return appendFinding(
    {
      db,
      argusHome: home,
      caseId: getCase(db, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      turnId: null
    },
    { title: 'F', markdown, layer: 'correctness', severity: 'major' }
  ).findingId
}

/** Materialize the worktree dir the resolver verifies against, with one real file. */
function seedWorktree(prNumber: number, rel: string): string {
  const wt = casePrWorktreeDir(home, 'c1', repoPath, prNumber)
  fs.mkdirSync(path.join(wt, path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(wt, rel), 'x')
  return wt
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-revwrite-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  repoPath = path.join(home, 'clones', 'widget')
  fs.mkdirSync(repoPath, { recursive: true })
  seedSession()
})

describe('resolveCommentTarget', () => {
  it('strips the PR WORKTREE directory name, which is what the agent actually sees', () => {
    // Found by the 2026-07-28 acceptance run. The review-run header hands the agent the
    // absolute worktree path, whose last segment is `<repo>-<case>-pr<n>` — so the agent cites
    // that, not the repo name the grammar asks for. Recognising only `repo`/basename(repoPath)
    // left the prefix unstripped and the path check then failed on a path that was correct.
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const wt = seedWorktree(42, 'src/auth.js')
    const id = finding(`See [${path.basename(wt)}/src/auth.js:69].`)
    const t = resolveCommentTarget({ db, argusHome: home }, 'c1', id)
    expect(t.repoRelPath).toBe('src/auth.js')
    expect(t.line).toBe(69)
  })

  it('strips the worktree directory name even before the worktree is materialized', () => {
    // The strip decision must not depend on the checkout existing — it is a naming rule, and
    // `worktreeFor` returning null is a legitimate state (manual link, failed materialization).
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const id = finding('See [widget-c1-pr42/src/auth.js:69].')
    const t = resolveCommentTarget({ db, argusHome: home }, 'c1', id)
    expect(t.repoRelPath).toBe('src/auth.js')
    expect(t.worktree).toBeNull()
  })

  it('strips the repo-name prefix the citation grammar requires', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('Inverted. See [widget/src/guard.ts:17].')
    const t = resolveCommentTarget({ db, argusHome: home }, 'c1', id)
    expect(t.repoRelPath).toBe('src/guard.ts')
    expect(t.line).toBe(17)
    expect(t.binding.number).toBe(42)
  })

  it('matches on the GitHub repo name when the clone directory is named differently', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget-sdk',
      number: 9,
      url: 'https://github.com/acme/widget-sdk/pull/9',
      source: 'manual'
    })
    seedWorktree(9, 'a/b.ts')
    const id = finding('See [widget-sdk/a/b.ts:3].')
    expect(resolveCommentTarget({ db, argusHome: home }, 'c1', id).repoRelPath).toBe('a/b.ts')
  })

  it('leaves an already repo-relative citation alone', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('See [src/guard.ts:17].')
    expect(resolveCommentTarget({ db, argusHome: home }, 'c1', id).repoRelPath).toBe('src/guard.ts')
  })

  it('rejects a finding with no diff anchor', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const id = finding('No citation here at all.')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id)).toThrow(/no diff anchor/i)
  })

  it('rejects when no PR is bound', () => {
    const id = finding('See [widget/src/guard.ts:17].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id)).toThrow(
      /no pull request/i
    )
  })

  it('rejects an unknown finding id with the same text as another case s id', () => {
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const foreign = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
         VALUES (?, NULL, NULL, 'other', 'pending', ?)`
      )
      .run(getCase(db, 'c2')!.id, new Date().toISOString())
    const unknownMsg = (() => {
      try {
        resolveCommentTarget({ db, argusHome: home }, 'c1', 999999)
      } catch (e) {
        return (e as Error).message
      }
      return ''
    })()
    const foreignMsg = (() => {
      try {
        resolveCommentTarget({ db, argusHome: home }, 'c1', Number(foreign.lastInsertRowid))
      } catch (e) {
        return (e as Error).message
      }
      return ''
    })()
    expect(unknownMsg).toBe(foreignMsg)
    expect(unknownMsg).toMatch(/unknown finding/i)
  })

  it('rejects a path that does not exist in the materialized worktree', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('See [widget/src/gone.ts:2].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id)).toThrow(/does not exist/i)
  })

  it("accepts a pr argument naming the case's bound PR", () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('See [widget/src/guard.ts:17].')
    const t = resolveCommentTarget({ db, argusHome: home }, 'c1', id, 'acme/widget#42')
    expect(t.binding.number).toBe(42)
    expect(t.repoRelPath).toBe('src/guard.ts')
  })

  it('a pr argument naming a PR that is not bound throws, even with a single binding', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('See [widget/src/guard.ts:17].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id, 'acme/widget#99')).toThrow(
      /acme\/widget#99/i
    )
  })

  it('an uncited (already repo-relative) finding makes no repo claim, so pr is not a contradiction', () => {
    // `named` is false here (the citation has no `<repo>/` prefix at all), so there is nothing
    // for `pr` to contradict — pr alone must still resolve it.
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('See [src/guard.ts:17].')
    const t = resolveCommentTarget({ db, argusHome: home }, 'c1', id, 'acme/widget#42')
    expect(t.binding.number).toBe(42)
    expect(t.repoRelPath).toBe('src/guard.ts')
  })

  it('rejects an absolute citation path even when the worktree is unmaterialized', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    // No seedWorktree() call: the worktree stays unmaterialized, so only the unconditional
    // check (not the fs.existsSync one, which is gated on `worktree` being non-null) can catch
    // this — a home-directory path would otherwise reach the PR-level fallback comment body.
    const id = finding('See [/Users/someone/repo/src/guard.ts:17].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id)).toThrow(
      /not a safe repo-relative path/i
    )
  })

  it('rejects a citation path with a ".." segment', () => {
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    const id = finding('See [widget/../../etc/passwd:1].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id)).toThrow(
      /not a safe repo-relative path/i
    )
  })
})
