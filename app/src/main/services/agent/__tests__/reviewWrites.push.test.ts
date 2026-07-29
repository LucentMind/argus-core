import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase, getCase } from '../../caseService'
import { addBinding } from '../../prBindings'
import { casePrWorktreeDir } from '../../prWorktree'
import { listFindings } from '../../findings'
import { appendFinding } from '../nativeTools'
import { pushReviewChange, type GitRunner } from '../reviewWrites'
import type { Runner } from '../../github'

let db: DatabaseSync
let home: string
let repoPath: string
let worktree: string

const headJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    headRefName: 'feature/guard',
    headRefOid: 'abc123',
    isCrossRepository: false,
    ...over
  })

const ghOk: Runner = async () => headJson()

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-revpush-'))
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
  worktree = casePrWorktreeDir(home, 'c1', repoPath, 42)
  fs.mkdirSync(worktree, { recursive: true })
})

function seedFinding(): number {
  return seedFindingCiting('See [widget/src/guard.ts:17].')
}

function seedFindingCiting(markdown: string): number {
  return appendFinding(
    {
      db,
      argusHome: home,
      caseId: getCase(db, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      turnId: null
    },
    { title: 'F', markdown, suggestedChange: 'flip it' }
  ).findingId
}

/**
 * A git runner that answers each subcommand from a script and records the calls (and the cwd
 * each was run in, so a test can prove the right worktree was touched).
 *
 * `!`-prefixed override values throw. `codes` lets a specific subcommand's thrown error carry
 * an exit code other than 1 — real `git merge-base --is-ancestor` exits 1 only for "not an
 * ancestor"; anything else (timeout, unresolvable sha) must propagate as a raw error instead of
 * being reported as staleness.
 */
function scriptedGit(
  over: Partial<Record<string, string>> = {},
  codes: Partial<Record<string, number>> = {}
): {
  git: GitRunner
  calls: string[][]
  cwds: string[]
} {
  const calls: string[][] = []
  const cwds: string[] = []
  const git: GitRunner = async (cwd, args) => {
    calls.push(args)
    cwds.push(cwd)
    const sub = args[0]
    if (sub in over) {
      const v = over[sub] as string
      if (v.startsWith('!')) {
        throw Object.assign(new Error(v.slice(1)), { code: codes[sub] ?? 1 })
      }
      return v
    }
    if (sub === 'status') return ' M src/guard.ts'
    if (sub === 'merge-base') return ''
    if (sub === 'rev-parse') return 'newsha1'
    return ''
  }
  return { git, calls, cwds }
}

/**
 * A DatabaseSync whose `prepare` throws for the finding-update statement only — every other
 * query (the ownership SELECT, getBinding) goes to the real db untouched. Mirrors
 * `dbThatFailsFindingUpdate` in reviewWrites.comment.test.ts: `Object.create` rather than a
 * `Proxy` because our own `prepare` property shadows the inherited one and is called with
 * `this = wrapper`, but its body only closes over `real` and never reads `this`, so it never
 * risks an "illegal invocation" against the native DatabaseSync internals the way rebinding the
 * real method to a different receiver would.
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

describe('pushReviewChange', () => {
  it('commits the worktree and pushes an explicit refspec to the PR branch', async () => {
    const { git, calls } = scriptedGit()
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
      findingIds: [id],
      commitMessage: 'fix: flip the inverted guard'
    })
    expect(out).toMatch(/newsha1/)
    expect(out).toMatch(/feature\/guard/)
    expect(calls).toContainEqual(['add', '-A'])
    expect(calls).toContainEqual(['commit', '-m', 'fix: flip the inverted guard'])
    expect(calls).toContainEqual(['push', 'origin', 'HEAD:refs/heads/feature/guard'])
    expect(calls.flat()).not.toContain('--force')
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBe('newsha1')
  })

  it('refuses an empty commit message before touching git or gh', async () => {
    const { git, calls } = scriptedGit()
    const gh: Runner = async () => {
      throw new Error('gh must not be called')
    }
    await expect(
      pushReviewChange({ db, argusHome: home, gh, git }, 'c1', {
        findingIds: [seedFinding()],
        commitMessage: '   '
      })
    ).rejects.toThrow(/empty/i)
    expect(calls).toEqual([])
  })

  it('refuses a fork PR before touching git', async () => {
    const { git, calls } = scriptedGit()
    const gh: Runner = async () => headJson({ isCrossRepository: true })
    await expect(
      pushReviewChange({ db, argusHome: home, gh, git }, 'c1', {
        findingIds: [seedFinding()],
        commitMessage: 'm'
      })
    ).rejects.toThrow(/fork/i)
    expect(calls).toEqual([])
  })

  it('refuses when the worktree has nothing to commit', async () => {
    // Clean AND at the PR's head sha (abc123, per ghOk/headJson) — genuinely nothing to do.
    // Post-fix, "clean" alone isn't enough: a clean-but-ahead worktree (a prior commit whose
    // push failed) has to fall through to a bare push instead — see the "ahead" test below.
    const { git, calls } = scriptedGit({ status: '', 'rev-parse': 'abc123' })
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [seedFinding()],
        commitMessage: 'm'
      })
    ).rejects.toThrow(/no uncommitted changes/i)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('refuses when the worktree is behind the PR head', async () => {
    const { git, calls } = scriptedGit({ 'merge-base': '!not an ancestor' })
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [seedFinding()],
        commitMessage: 'm'
      })
    ).rejects.toThrow(/behind PR #42/i)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('propagates a merge-base failure that is not exit code 1 as a raw error, not staleness', async () => {
    const { git, calls } = scriptedGit(
      { 'merge-base': '!fatal: unable to resolve ref feature/guard' },
      { 'merge-base': 128 }
    )
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [seedFinding()],
        commitMessage: 'm'
      })
    ).rejects.toThrow(/unable to resolve ref/)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('pushes without committing when the tree is clean but HEAD is already ahead of the PR head', async () => {
    // Simulates a retry after a previous call committed locally but the push itself failed:
    // clean tree, HEAD != the PR's last-seen head sha (abc123).
    const { git, calls } = scriptedGit({ status: '', 'rev-parse': 'aheadsha1' })
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
      findingIds: [id],
      commitMessage: 'm'
    })
    expect(calls.map((c) => c[0])).not.toContain('add')
    expect(calls.map((c) => c[0])).not.toContain('commit')
    expect(calls).toContainEqual(['push', 'origin', 'HEAD:refs/heads/feature/guard'])
    expect(out).toMatch(/aheadsha1/)
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBe('aheadsha1')
  })

  it('refuses when the PR was never checked out locally', async () => {
    fs.rmSync(worktree, { recursive: true, force: true })
    const { git } = scriptedGit()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [seedFinding()],
        commitMessage: 'm'
      })
    ).rejects.toThrow(/no local checkout/i)
  })

  it('surfaces a rejected push and records nothing', async () => {
    const { git } = scriptedGit({
      push: '! ! [rejected] feature/guard -> feature/guard (fetch first)'
    })
    const id = seedFinding()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [id],
        commitMessage: 'm'
      })
    ).rejects.toThrow(/rejected/)
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBeNull()
  })
})

describe('pushReviewChange — pr argument', () => {
  it("accepts a pr argument naming the case's bound PR", async () => {
    const { git, calls } = scriptedGit()
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
      findingIds: [id],
      commitMessage: 'm',
      expectPr: 'acme/widget#42'
    })
    expect(out).toContain('#42')
    expect(calls).toContainEqual(['push', 'origin', 'HEAD:refs/heads/feature/guard'])
  })

  it('a pr argument naming a PR that is not bound throws', async () => {
    const { git, calls } = scriptedGit()
    const id = seedFinding()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [id],
        commitMessage: 'm',
        expectPr: 'acme/widget#999'
      })
    ).rejects.toThrow(/acme\/widget#999/i)
    expect(calls).toEqual([])
  })
})

describe('pushReviewChange — batch finding ids', () => {
  it('stamps the pushed sha on every finding id', async () => {
    const { git } = scriptedGit({ 'rev-parse': 'newsha000000' })
    const idA = seedFinding()
    const idB = seedFinding()
    await pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
      findingIds: [idA, idB],
      commitMessage: 'fix: both',
      expectPr: 'acme/widget#42'
    })
    for (const id of [idA, idB]) {
      expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBe('newsha000000')
    }
  })

  it("rejects the whole call when ANY id is not this case's", async () => {
    const { git, calls } = scriptedGit()
    const idA = seedFinding()
    createCase(db, home, { slug: 'c2', title: 'Case 2' })
    const otherCaseId = Number(
      db
        .prepare(
          `INSERT INTO findings (case_id, session_id, turn_id, summary, review_state, created_at)
           VALUES (?, NULL, NULL, 'other', 'pending', ?)`
        )
        .run(getCase(db, 'c2')!.id, new Date().toISOString()).lastInsertRowid
    )
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [idA, otherCaseId],
        commitMessage: 'm',
        expectPr: 'acme/widget#42'
      })
    ).rejects.toThrow('Unknown finding id.')
    // and nothing was pushed
    expect(calls.filter((c) => c[0] === 'push')).toEqual([])
  })

  it('rejects an empty findingIds list before any git work', async () => {
    const { git, calls } = scriptedGit()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingIds: [],
        commitMessage: 'm'
      })
    ).rejects.toThrow(/at least one finding/i)
    expect(calls).toEqual([])
  })

  it('a recordFindingWrite failure after a landed push still reports push-ok, not a failure', async () => {
    // Was: the stamping loop ran unguarded AFTER the push landed. A recordFindingWrite failure
    // partway through the batch used to reject pushReviewChange entirely — telling the model the
    // push had failed while it was actually live on the PR branch, inviting a retry that would
    // push again. The fix wraps the loop (mirroring postReviewComment's recordFindingWrite wrap)
    // so this still returns success with a note instead of throwing.
    const { git, calls } = scriptedGit({ 'rev-parse': 'newsha000000' })
    const idA = seedFinding()
    const idB = seedFinding()
    const failingDb = dbThatFailsFindingUpdate(db, 'db write failed')
    const out = await pushReviewChange({ db: failingDb, argusHome: home, gh: ghOk, git }, 'c1', {
      findingIds: [idA, idB],
      commitMessage: 'fix: both',
      expectPr: 'acme/widget#42'
    })
    expect(out).toMatch(/newsha000000/)
    expect(out).toContain('feature/guard')
    expect(out).toMatch(/could not be recorded locally/i)
    // The push actually happened — the refspec was recorded before the (failing) stamping loop.
    expect(calls).toContainEqual(['push', 'origin', 'HEAD:refs/heads/feature/guard'])
    // neither finding got stamped, since the very first recordFindingWrite call already throws
    for (const id of [idA, idB]) {
      expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBeNull()
    }
  })
})

describe('pushReviewChange against real git', () => {
  it('lands the commit on the PR head branch of a real remote', async () => {
    const origin = path.join(home, 'origin.git')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin])
    const seed = path.join(home, 'seed')
    execFileSync('git', ['clone', origin, seed])
    const g = (...args: string[]): void => {
      execFileSync('git', args, { cwd: seed })
    }
    fs.writeFileSync(path.join(seed, 'file.txt'), 'one\n')
    g('add', '-A')
    g('-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'seed')
    g('push', 'origin', 'main:refs/heads/feature/guard')
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seed }).toString().trim()

    fs.rmSync(worktree, { recursive: true, force: true })
    execFileSync('git', ['clone', origin, worktree])
    execFileSync('git', ['switch', '--detach', 'origin/feature/guard'], { cwd: worktree })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: worktree })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: worktree })
    fs.writeFileSync(path.join(worktree, 'file.txt'), 'two\n')

    const gh: Runner = async () =>
      JSON.stringify({
        headRefName: 'feature/guard',
        headRefOid: baseSha,
        isCrossRepository: false
      })
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh }, 'c1', {
      findingIds: [id],
      commitMessage: 'fix: flip the inverted guard'
    })

    const remoteLog = execFileSync(
      'git',
      ['log', '-1', '--format=%s', 'refs/heads/feature/guard'],
      {
        cwd: origin
      }
    )
      .toString()
      .trim()
    expect(remoteLog).toBe('fix: flip the inverted guard')
    expect(out).toContain('feature/guard')
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toHaveLength(40)
  }, 30_000)
})
