import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { listFindings } from '../../findings'
import { appendFinding } from '../nativeTools'
import { postReviewComment } from '../reviewWrites'
import type { Runner } from '../../github'

let db: DatabaseSync
let home: string
let repoPath: string

const HEAD_JSON = JSON.stringify({
  headRefName: 'feature/guard',
  headRefOid: 'abc123',
  isCrossRepository: false
})

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-revcomment-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'c1', title: 'Case 1' })
  repoPath = path.join(home, 'clones', 'widget')
  fs.mkdirSync(repoPath, { recursive: true })
  // `updated_at` is NOT NULL with no default (db.ts:50) — omitting it fails the insert.
  const nowIso = new Date().toISOString()
  db.prepare(
    `INSERT INTO sessions (id, case_id, mode, created_at, updated_at) VALUES (1, ?, 'review', ?, ?)`
  ).run(getCase(db, 'c1')!.id, nowIso, nowIso)
  addBinding(db, 'c1', {
    repoPath,
    owner: 'acme',
    repo: 'widget',
    number: 42,
    url: 'https://github.com/acme/widget/pull/42',
    source: 'manual'
  })
  const wt = casePrWorktreeDir(home, 'c1', repoPath, 42)
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt, 'src', 'guard.ts'), 'x')
})

function seedFinding(): number {
  return appendFinding(
    {
      db,
      argusHome: home,
      caseId: getCase(db, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      turnId: null
    },
    {
      title: 'Inverted guard',
      markdown: 'Inverted. See [widget/src/guard.ts:17].',
      layer: 'correctness',
      severity: 'major'
    }
  ).findingId
}

/**
 * A DatabaseSync whose `prepare` throws for the finding-update statement only — every other
 * query (the ownership SELECT, getBinding) goes to the real db untouched. `Object.create`
 * rather than a `Proxy`: our own `prepare` property shadows the inherited one and is called
 * with `this = wrapper`, but its body only closes over `real` and never reads `this`, so it
 * never risks an "illegal invocation" against the native DatabaseSync internals the way
 * rebinding the real method to a different receiver would.
 */
function dbThatFailsFindingUpdate(real: DatabaseSync, message: string): DatabaseSync {
  const wrapper = Object.create(real) as DatabaseSync
  const fakePrepare = (sql: string, ...rest: unknown[]): unknown => {
    if (/^\s*UPDATE\s+findings/i.test(sql)) throw new Error(message)
    return (real.prepare as (...a: unknown[]) => unknown)(sql, ...rest)
  }
  Object.defineProperty(wrapper, 'prepare', { value: fakePrepare })
  return wrapper
}

describe('postReviewComment', () => {
  it('posts an inline comment on the head commit and records the url', async () => {
    const calls: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      calls.push(args)
      if (args[0] === 'pr') return HEAD_JSON
      return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#discussion_r1' })
    }
    const id = seedFinding()
    const out = await postReviewComment({ db, argusHome: home, gh }, 'c1', {
      findingId: id,
      body: 'This guard is inverted.'
    })
    expect(out).toContain('https://github.com/acme/widget/pull/42#discussion_r1')
    expect(calls[1]).toContain('repos/acme/widget/pulls/42/comments')
    expect(calls[1]).toContain('commit_id=abc123')
    expect(calls[1]).toContain('path=src/guard.ts')
    expect(calls[1]).toContain('line=17')
    const row = listFindings(db, home, 'c1').find((f) => f.id === id)
    expect(row?.commentUrl).toBe('https://github.com/acme/widget/pull/42#discussion_r1')
  })

  it('falls back to a PR-level comment when the line is not in the diff', async () => {
    const calls: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      calls.push(args)
      if (args[0] === 'pr') return HEAD_JSON
      if (args[3].includes('/pulls/')) {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'HTTP 422: line must be part of the diff'
        })
      }
      return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#issuecomment-9' })
    }
    const id = seedFinding()
    const out = await postReviewComment({ db, argusHome: home, gh }, 'c1', {
      findingId: id,
      body: 'This guard is inverted.'
    })
    expect(out).toMatch(/not part of the diff/i)
    expect(out).toContain('#issuecomment-9')
    // the fallback body carries the anchor the inline comment would have provided
    const issueArgs = calls[2]
    expect(issueArgs).toContain('repos/acme/widget/issues/42/comments')
    expect(issueArgs.join(' ')).toContain('src/guard.ts:17')
    const row = listFindings(db, home, 'c1').find((f) => f.id === id)
    expect(row?.commentUrl).toContain('#issuecomment-9')
  })

  it('does not swallow a real gh failure', async () => {
    const gh: Runner = async (_cmd, args) => {
      if (args[0] === 'pr') return HEAD_JSON
      throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 403: Forbidden' })
    }
    const id = seedFinding()
    await expect(
      postReviewComment({ db, argusHome: home, gh }, 'c1', { findingId: id, body: 'x' })
    ).rejects.toThrow(/403/)
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.commentUrl).toBeNull()
  })

  it('rejects an empty body before calling gh at all', async () => {
    const gh: Runner = async () => {
      throw new Error('gh must not be called')
    }
    const id = seedFinding()
    await expect(
      postReviewComment({ db, argusHome: home, gh }, 'c1', { findingId: id, body: '   ' })
    ).rejects.toThrow(/empty/i)
  })

  it('a recordFindingWrite failure after a successful post still reports comment-ok, not a failure', async () => {
    // Was: "propagates as itself, not a gh retry/duplicate" — a recordFindingWrite failure used
    // to reject postReviewComment entirely, which told the model the write had failed while the
    // comment was already live on the PR. A retry from the model would then duplicate it. The
    // fix (wave 5) wraps the recordFindingWrite call so this case still returns success with a
    // note instead of throwing — the model is told the comment posted AND that it could not be
    // recorded locally, so it neither retries nor believes nothing happened.
    const ghCalls: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      ghCalls.push(args)
      if (args[0] === 'pr') return HEAD_JSON
      return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#discussion_r1' })
    }
    const id = seedFinding()
    // The message is deliberately gh-flavored ("part of the diff") to pin the OLD bug: with
    // recordFindingWrite still inside the original try/catch, this message would satisfy
    // isLineNotInDiff and the catch block would retry as a SECOND gh call (postIssueComment) —
    // an actual duplicate post. It now resolves instead of throwing, so no second gh call
    // happens either way.
    const failingDb = dbThatFailsFindingUpdate(db, 'db write failed: part of the diff')
    const out = await postReviewComment({ db: failingDb, argusHome: home, gh }, 'c1', {
      findingId: id,
      body: 'x'
    })
    expect(out).toContain('https://github.com/acme/widget/pull/42#discussion_r1')
    expect(out).toMatch(/could not be recorded locally/i)
    // Exactly the head lookup + the one inline post — no fallback issue-comment call.
    expect(ghCalls).toHaveLength(2)
    // the finding row is untouched — the whole point is that the DB write never landed
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.commentUrl).toBeNull()
  })

  // The mirror of the test above, for the OTHER return branch: the inline post fails with
  // "not part of the diff", the PR-level fallback succeeds, and THEN recordFindingWrite
  // fails. Both branches share the one recordFindingWrite call site (see postReviewComment's
  // try/catch around it) but return different feedback text (comment-not-inline vs.
  // comment-ok) — this pins that the not-recorded note is appended to the right one.
  it('a recordFindingWrite failure after a PR-level fallback post still reports comment-not-inline, not a failure', async () => {
    const ghCalls: string[][] = []
    const gh: Runner = async (_cmd, args) => {
      ghCalls.push(args)
      if (args[0] === 'pr') return HEAD_JSON
      if (args[3].includes('/pulls/')) {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'HTTP 422: line must be part of the diff'
        })
      }
      return JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#issuecomment-9' })
    }
    const id = seedFinding()
    const failingDb = dbThatFailsFindingUpdate(db, 'db write failed')
    const out = await postReviewComment({ db: failingDb, argusHome: home, gh }, 'c1', {
      findingId: id,
      body: 'This guard is inverted.'
    })
    expect(out).toMatch(/not part of the diff/i)
    expect(out).toContain('#issuecomment-9')
    expect(out).toMatch(/could not be recorded locally/i)
    // head lookup + failed inline attempt + the fallback issue-comment post — no retry beyond that
    expect(ghCalls).toHaveLength(3)
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.commentUrl).toBeNull()
  })

  it('refuses a finding id from another case with the unknown-finding text', async () => {
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    const foreign = db
      .prepare(
        `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
         VALUES (?, NULL, NULL, 'other', 'pending', ?)`
      )
      .run(getCase(db, 'c2')!.id, new Date().toISOString())
    const gh: Runner = async () => {
      throw new Error('gh must not be called')
    }
    await expect(
      postReviewComment({ db, argusHome: home, gh }, 'c1', {
        findingId: Number(foreign.lastInsertRowid),
        body: 'x'
      })
    ).rejects.toThrow(/unknown finding/i)
  })
})
