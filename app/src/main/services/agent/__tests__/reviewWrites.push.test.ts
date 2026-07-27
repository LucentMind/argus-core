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
  return appendFinding(
    {
      db,
      argusHome: home,
      caseId: getCase(db, 'c1')!.id,
      caseSlug: 'c1',
      sessionId: 1,
      turnId: null
    },
    { title: 'F', markdown: 'See [widget/src/guard.ts:17].', suggestedChange: 'flip it' }
  ).findingId
}

/** A git runner that answers each subcommand from a script and records the calls. */
function scriptedGit(over: Partial<Record<string, string>> = {}): {
  git: GitRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const git: GitRunner = async (_cwd, args) => {
    calls.push(args)
    const sub = args[0]
    if (sub in over) {
      const v = over[sub] as string
      if (v.startsWith('!')) throw new Error(v.slice(1))
      return v
    }
    if (sub === 'status') return ' M src/guard.ts'
    if (sub === 'merge-base') return ''
    if (sub === 'rev-parse') return 'newsha1'
    return ''
  }
  return { git, calls }
}

describe('pushReviewChange', () => {
  it('commits the worktree and pushes an explicit refspec to the PR branch', async () => {
    const { git, calls } = scriptedGit()
    const id = seedFinding()
    const out = await pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
      findingId: id,
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

  it('refuses a fork PR before touching git', async () => {
    const { git, calls } = scriptedGit()
    const gh: Runner = async () => headJson({ isCrossRepository: true })
    await expect(
      pushReviewChange({ db, argusHome: home, gh, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/fork/i)
    expect(calls).toEqual([])
  })

  it('refuses when the worktree has nothing to commit', async () => {
    const { git, calls } = scriptedGit({ status: '' })
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/no uncommitted changes/i)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('refuses when the worktree is behind the PR head', async () => {
    const { git, calls } = scriptedGit({ 'merge-base': '!not an ancestor' })
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: seedFinding(),
        commitMessage: 'm'
      })
    ).rejects.toThrow(/behind PR #42/i)
    expect(calls.map((c) => c[0])).not.toContain('commit')
  })

  it('refuses when the PR was never checked out locally', async () => {
    fs.rmSync(worktree, { recursive: true, force: true })
    const { git } = scriptedGit()
    await expect(
      pushReviewChange({ db, argusHome: home, gh: ghOk, git }, 'c1', {
        findingId: seedFinding(),
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
        findingId: id,
        commitMessage: 'm'
      })
    ).rejects.toThrow(/rejected/)
    expect(listFindings(db, home, 'c1').find((f) => f.id === id)?.pushedSha).toBeNull()
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
      findingId: id,
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
