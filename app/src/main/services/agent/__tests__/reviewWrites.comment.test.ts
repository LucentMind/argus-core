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
