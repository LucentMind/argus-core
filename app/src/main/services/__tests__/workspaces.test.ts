import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import {
  linkWorkspace,
  unlinkWorkspace,
  listWorkspaces,
  ensureWorktree,
  worktreesRoot,
  workspaceSandboxRoots,
  autoLinkDefaultRepo
} from '../workspaces'
import type { DatabaseSync } from 'node:sqlite'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let tmp: string, argusHome: string, repo: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ws-'))
  argusHome = path.join(tmp, 'ArgusHome')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'c1')
  git(repo, 'branch', 'feature/x')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-1', title: 'test' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('workspace service', () => {
  it('links a valid repo and records remote/branch in db + case.json', async () => {
    const ws = await linkWorkspace(db, argusHome, 'NAV-1', repo)
    expect(ws.path).toBe(repo)
    expect(ws.currentRef).toBe('main')
    expect(ws.dirty).toBe(false)
    const caseJson = JSON.parse(
      fs.readFileSync(path.join(argusHome, 'cases', 'NAV-1', 'case.json'), 'utf8')
    )
    expect(caseJson.workspaces).toHaveLength(1)
  })

  it('rejects a non-repo path', async () => {
    await expect(linkWorkspace(db, argusHome, 'NAV-1', tmp)).rejects.toThrow(
      /not a git repository/i
    )
  })

  it('reports dirty state', async () => {
    await linkWorkspace(db, argusHome, 'NAV-1', repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    const [ws] = await listWorkspaces(db, argusHome, 'NAV-1')
    expect(ws.dirty).toBe(true)
  })

  it('materializes a case worktree without touching the primary checkout', async () => {
    await linkWorkspace(db, argusHome, 'NAV-1', repo)
    const wt = await ensureWorktree(argusHome, 'NAV-1', repo, 'feature/x')
    expect(wt.startsWith(worktreesRoot(argusHome))).toBe(true)
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x')
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main') // untouched
    // idempotent
    await expect(ensureWorktree(argusHome, 'NAV-1', repo, 'feature/x')).resolves.toBe(wt)
  })

  it('serializes concurrent worktree ops on the same repo', async () => {
    await linkWorkspace(db, argusHome, 'NAV-1', repo)
    createCase(db, argusHome, { slug: 'NAV-2', title: 'test2' })
    await linkWorkspace(db, argusHome, 'NAV-2', repo)
    const [w1, w2] = await Promise.all([
      ensureWorktree(argusHome, 'NAV-1', repo, 'feature/x'),
      ensureWorktree(argusHome, 'NAV-2', repo, 'main')
    ])
    expect(w1).not.toBe(w2)
    expect(fs.existsSync(w1)).toBe(true)
    expect(fs.existsSync(w2)).toBe(true)
  })

  it('unlink removes the case worktree', async () => {
    await linkWorkspace(db, argusHome, 'NAV-1', repo)
    const wt = await ensureWorktree(argusHome, 'NAV-1', repo, 'feature/x')
    await unlinkWorkspace(db, argusHome, 'NAV-1', repo)
    expect(fs.existsSync(wt)).toBe(false)
    expect(await listWorkspaces(db, argusHome, 'NAV-1')).toHaveLength(0)
  })

  it('surfaces the ref name for a detached worktree instead of "HEAD"', async () => {
    git(repo, 'tag', 'v3.16.0') // tag c1
    // a PR-style ref at a unique commit, reachable only via refs/pull/*
    git(repo, 'commit', '--allow-empty', '-m', 'pr-only')
    const prSha = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'update-ref', 'refs/pull/123/head', prSha)
    git(repo, 'reset', '--hard', 'HEAD~1') // move main back off the PR commit
    await linkWorkspace(db, argusHome, 'NAV-1', repo)

    // tag checkout → detached; chip should read "v3.16.0", not "HEAD"
    await ensureWorktree(argusHome, 'NAV-1', repo, 'v3.16.0')
    let [ws] = await listWorkspaces(db, argusHome, 'NAV-1')
    expect(ws.worktreePath).not.toBeNull()
    expect(ws.currentRef).toBe('v3.16.0')

    // PR-ref checkout → detached; chip should read "pull/123/head"
    await ensureWorktree(argusHome, 'NAV-1', repo, 'refs/pull/123/head')
    ;[ws] = await listWorkspaces(db, argusHome, 'NAV-1')
    expect(ws.currentRef).toBe('pull/123/head')
  })

  it('ensureWorktree stays on branch ref when called twice', async () => {
    await linkWorkspace(db, argusHome, 'NAV-1', repo)
    const wt = await ensureWorktree(argusHome, 'NAV-1', repo, 'feature/x')
    // First call should attach to the branch
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x')
    // Second call should not detach the worktree
    await ensureWorktree(argusHome, 'NAV-1', repo, 'feature/x')
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x')
  })

  // Regression guard: the graphs cache must stay read-only to the agent. It is exposed via
  // skillsRoots -> readonlyRoots (session.ts), never via workspaceSandboxRoots, which feeds
  // riskCtx.workspaceRoots where FS Write/Edit are auto-allowed.
  it('workspaceSandboxRoots does not include the graphs directory', async () => {
    await linkWorkspace(db, argusHome, 'NAV-1', repo)
    const roots = await workspaceSandboxRoots(db, argusHome, 'NAV-1')
    expect(roots).not.toContain(path.join(argusHome, 'graphs'))
  })
})

describe('autoLinkDefaultRepo', () => {
  it('links the default repo to a new case', async () => {
    await autoLinkDefaultRepo(db, argusHome, 'NAV-1', repo)
    const list = await listWorkspaces(db, argusHome, 'NAV-1')
    expect(list.map((w) => w.path)).toEqual([repo])
  })

  it('is a no-op when defaultRepo is null', async () => {
    await autoLinkDefaultRepo(db, argusHome, 'NAV-1', null)
    expect(await listWorkspaces(db, argusHome, 'NAV-1')).toEqual([])
  })

  it('never throws for an invalid repo path', async () => {
    await expect(autoLinkDefaultRepo(db, argusHome, 'NAV-1', tmp)).resolves.toBeUndefined()
    expect(await listWorkspaces(db, argusHome, 'NAV-1')).toEqual([])
  })
})
