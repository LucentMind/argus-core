import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureWorktree, worktreesRoot } from '../workspaces'
import { casePrWorktreeDir, ensurePrWorktree } from '../prWorktree'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A GitRunner that records argv and delegates to the REAL git, so a test can assert which
 *  commands ran without faking any of their behaviour. */
function recorder(): { calls: string[][]; run: (cwd: string, args: string[]) => Promise<string> } {
  const calls: string[][] = []
  return {
    calls,
    run: async (cwd, args) => {
      calls.push(args)
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()
    }
  }
}

let tmp: string, argusHome: string, origin: string, repo: string, prSha: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prwt-'))
  argusHome = path.join(tmp, 'ArgusHome')

  // An "origin" carrying a refs/pull/1/head ref, the way GitHub exposes a PR head.
  origin = path.join(tmp, 'origin')
  fs.mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-b', 'main')
  git(origin, 'config', 'user.email', 't@t')
  git(origin, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(origin, 'a.txt'), 'one\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-m', 'c1')
  git(origin, 'branch', 'feature/x')
  git(origin, 'checkout', '-b', 'pr-work')
  fs.writeFileSync(path.join(origin, 'a.txt'), 'two\n')
  git(origin, 'commit', '-am', 'pr commit')
  prSha = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'update-ref', 'refs/pull/1/head', prSha)
  git(origin, 'checkout', 'main')

  repo = path.join(tmp, 'repo')
  git(tmp, 'clone', origin, repo)
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ensurePrWorktree', () => {
  it('materializes the PR head in a PR-specific directory', async () => {
    const wt = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    expect(wt).toBe(casePrWorktreeDir(argusHome, 'NAV-1', repo, 1))
    expect(path.basename(wt)).toBe('repo-NAV-1-pr1')
    expect(wt.startsWith(worktreesRoot(argusHome))).toBe(true)
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prSha)
  })

  it('is idempotent — a second call returns the same path and does not throw', async () => {
    const first = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    const second = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    expect(second).toBe(first)
    expect(git(second, 'rev-parse', 'HEAD')).toBe(prSha)
  })

  it('does not disturb the case worktree for the same repo+case', async () => {
    const branchWt = await ensureWorktree(argusHome, 'NAV-1', repo, 'feature/x')
    const before = git(branchWt, 'rev-parse', 'HEAD')

    const prWt = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    expect(prWt).not.toBe(branchWt)
    expect(git(branchWt, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(branchWt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x')
  })

  it('leaves the primary checkout on its own branch', async () => {
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('re-points an existing PR worktree when the PR head moves', async () => {
    const wt = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prSha)

    // the PR gains a commit upstream
    git(origin, 'checkout', 'pr-work')
    fs.writeFileSync(path.join(origin, 'a.txt'), 'three\n')
    git(origin, 'commit', '-am', 'pr commit 2')
    const moved = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'update-ref', 'refs/pull/1/head', moved)
    git(origin, 'checkout', 'main')

    const rec = recorder()
    expect(await ensurePrWorktree(argusHome, 'NAV-1', repo, 1, { run: rec.run })).toBe(wt)
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(moved)
    // The probe found a difference, so the fetch must have run — this is the half of the
    // fast path that must NOT trigger.
    expect(rec.calls.some((a) => a[0] === 'fetch')).toBe(true)
  })

  it('does not fetch when the worktree already sits on the PR head', async () => {
    await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)

    const rec = recorder()
    const again = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1, { run: rec.run })

    expect(again).toBe(casePrWorktreeDir(argusHome, 'NAV-1', repo, 1))
    expect(git(again, 'rev-parse', 'HEAD')).toBe(prSha)
    expect(rec.calls.some((a) => a[0] === 'fetch')).toBe(false)
    expect(rec.calls.some((a) => a[0] === 'ls-remote')).toBe(true)
  })

  it('fetches when there is no worktree yet — the probe must not short-circuit', async () => {
    const rec = recorder()
    await ensurePrWorktree(argusHome, 'NAV-1', repo, 1, { run: rec.run })

    expect(rec.calls.some((a) => a[0] === 'fetch')).toBe(true)
    expect(rec.calls.some((a) => a[0] === 'ls-remote')).toBe(false)
  })

  it('routes every git call through an injected runner', async () => {
    const rec = recorder()
    const wt = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1, { run: rec.run })
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prSha)
    expect(rec.calls.length).toBeGreaterThan(0)
    expect(rec.calls.some((a) => a[0] === 'fetch')).toBe(true)
  })

  it('leaves refs/argus/pr/N naming the PR head after a skipped fetch', async () => {
    await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    // Drag the ref backwards; only the skip path's update-ref can put it back, since this
    // second call performs no fetch.
    const base = git(repo, 'rev-parse', 'origin/main')
    git(repo, 'update-ref', 'refs/argus/pr/1', base)

    const rec = recorder()
    await ensurePrWorktree(argusHome, 'NAV-1', repo, 1, { run: rec.run })

    expect(rec.calls.some((a) => a[0] === 'fetch')).toBe(false)
    expect(git(repo, 'rev-parse', 'refs/argus/pr/1')).toBe(prSha)
  })

  it('falls through to the fetch when the probe cannot reach the remote', async () => {
    const wt = await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    git(repo, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such-remote'))

    // The probe returns null rather than throwing, so the fetch runs and fails the way it
    // always has — never a silent early return on a worktree we could not verify.
    await expect(ensurePrWorktree(argusHome, 'NAV-1', repo, 1)).rejects.toThrow()
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(prSha)
  })

  it('falls through to the fetch — and its error — when origin is gone', async () => {
    await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)
    git(repo, 'remote', 'remove', 'origin')
    await expect(ensurePrWorktree(argusHome, 'NAV-1', repo, 1)).rejects.toThrow(
      /No 'origin' remote/
    )
  })
})
