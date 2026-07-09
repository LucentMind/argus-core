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
  worktreesRoot
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
})
