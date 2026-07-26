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

    expect(await ensurePrWorktree(argusHome, 'NAV-1', repo, 1)).toBe(wt)
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(moved)
  })
})
