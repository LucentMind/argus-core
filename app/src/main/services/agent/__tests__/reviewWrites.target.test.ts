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
  return seedWorktreeFor(repoPath, prNumber, rel)
}

/** Same as `seedWorktree`, but for a second repo clone (multi-binding tests). */
function seedWorktreeFor(repoP: string, prNumber: number, rel: string): string {
  const wt = casePrWorktreeDir(home, 'c1', repoP, prNumber)
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

  it('rejects an ambiguous citation when two PRs are bound and neither name matches', () => {
    const repoPath2 = path.join(home, 'clones', 'gadget')
    fs.mkdirSync(repoPath2, { recursive: true })
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    addBinding(db, 'c1', {
      repoPath: repoPath2,
      owner: 'acme',
      repo: 'gadget',
      number: 7,
      url: 'https://github.com/acme/gadget/pull/7',
      source: 'manual'
    })
    // Neither binding's worktree is materialized, so a silent bindings[0] fallback here
    // would go unchecked and post to the wrong PR.
    const id = finding('See [other/src/x.ts:1].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id)).toThrow(
      /bound pull requests/i
    )
  })

  it('still resolves the matching PR when two are bound and the prefix names one of them', () => {
    const repoPath2 = path.join(home, 'clones', 'gadget')
    fs.mkdirSync(repoPath2, { recursive: true })
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    addBinding(db, 'c1', {
      repoPath: repoPath2,
      owner: 'acme',
      repo: 'gadget',
      number: 7,
      url: 'https://github.com/acme/gadget/pull/7',
      source: 'manual'
    })
    seedWorktreeFor(repoPath2, 7, 'a/b.ts')
    const id = finding('See [gadget/a/b.ts:5].')
    const t = resolveCommentTarget({ db, argusHome: home }, 'c1', id)
    expect(t.repoRelPath).toBe('a/b.ts')
    expect(t.binding.number).toBe(7)
  })

  it('rejects a same-repo citation when two PRs from the same repo are bound (#42/#43), instead of picking bindings[0]', () => {
    // pr_bindings' unique key is (case_id, owner, repo, number) — nothing stops binding both
    // #42 and #43 of the SAME repo to one case (IPC.prLinkMany from a single search does
    // exactly this). Both match the `widget/` citation prefix, so the pre-fix `find` would
    // silently return whichever `listBindings` (newest first) happened to return first.
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 43,
      url: 'https://github.com/acme/widget/pull/43',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('See [widget/src/guard.ts:17].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id)).toThrow(
      /bound pull requests in widget/i
    )
  })

  it('an explicit pr argument picks the right one of two same-repo bindings', () => {
    // #43 is added AFTER #42, so listBindings (newest first) puts #43 at bindings[0] — an
    // implementation that parsed `pr`, did the unknown-pr membership check, and then still
    // returned bindings[0] regardless would pass a "pick #43" assertion by coincidence. Picking
    // #42 here — the one that is NOT bindings[0] — is the assertion that actually distinguishes
    // "pr genuinely selects the binding" from "pr is checked but ignored".
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 43,
      url: 'https://github.com/acme/widget/pull/43',
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

  it('rejects a pr that contradicts the citation instead of silently overriding it', () => {
    // acme/widget#42 (worktree materialized) and acme/gadget#7 (manual link, no local clone) are
    // both bound. The finding cites [widget/...], naming widget — but the agent passes
    // pr: acme/gadget#7. Without this check, `match` (gadget#7) would win outright: `named`
    // wouldn't include it so the citation's path prefix would NOT get stripped, gadget's
    // worktree is null so the path-missing check is skipped, and a 422-on-non-diff-line fallback
    // would publish a comment ABOUT widget's citation onto gadget's PR — the exact "wrong PR"
    // class this whole fix wave exists to prevent, reachable through the mechanism that fixed it.
    addBinding(db, 'c1', {
      repoPath,
      owner: 'acme',
      repo: 'widget',
      number: 42,
      url: 'https://github.com/acme/widget/pull/42',
      source: 'manual'
    })
    addBinding(db, 'c1', {
      repoPath: null,
      owner: 'acme',
      repo: 'gadget',
      number: 7,
      url: 'https://github.com/acme/gadget/pull/7',
      source: 'manual'
    })
    seedWorktree(42, 'src/guard.ts')
    const id = finding('See [widget/src/guard.ts:17].')
    expect(() => resolveCommentTarget({ db, argusHome: home }, 'c1', id, 'acme/gadget#7')).toThrow(
      /widget/i
    )
  })

  it('an uncited (already repo-relative) finding makes no repo claim, so pr is not a contradiction', () => {
    // named.length === 0 here (the citation has no `<repo>/` prefix at all), so there is nothing
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
