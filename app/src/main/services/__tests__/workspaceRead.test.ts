import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { linkWorkspace, ensureWorktree } from '../workspaces'
import { readRepoSnippet, readRepoText, resolveRepoTree } from '../workspaceRead'
import { WINDOW_LINES_BEFORE } from '../search'
import { MAX_SNIPPET_LINES, SNIPPET_BEFORE, SNIPPET_AFTER } from '../../../shared/snippets'
import type { DatabaseSync } from 'node:sqlite'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let tmp: string, argusHome: string, repo: string, db: DatabaseSync

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-wsread-'))
  argusHome = path.join(tmp, 'ArgusHome')
  repo = path.join(tmp, 'myrepo')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  fs.writeFileSync(
    path.join(repo, 'src', 'camera.ts'),
    Array.from({ length: 60 }, (_, i) => `code line ${i + 1}`).join('\n') + '\n'
  )
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'c1')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-1', title: 'test' })
  await linkWorkspace(db, argusHome, 'NAV-1', repo)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveRepoTree', () => {
  it('matches the repo basename case-insensitively and prefers the primary checkout', () => {
    expect(resolveRepoTree(db, argusHome, 'NAV-1', 'MyRepo')).toBe(repo)
    expect(resolveRepoTree(db, argusHome, 'NAV-1', 'nope')).toBeNull()
  })

  it('prefers the case worktree once one exists', async () => {
    const wt = await ensureWorktree(argusHome, 'NAV-1', repo, 'main')
    expect(resolveRepoTree(db, argusHome, 'NAV-1', 'myrepo')).toBe(wt)
  })
})

describe('readRepoSnippet', () => {
  it('reads a range window with lang and ref', async () => {
    const r = await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', 'src/camera.ts', 20, 24)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.startLine).toBe(20 - SNIPPET_BEFORE)
    expect(r.lines[0]).toBe(`code line ${20 - SNIPPET_BEFORE}`)
    expect(r.lines[r.lines.length - 1]).toBe(`code line ${24 + SNIPPET_AFTER}`)
    expect(r.lang).toBe('typescript')
    expect(r.ref).toBe('main')
    expect(r.truncated).toBe(false)
  })

  it('caps huge ranges and flags truncated', async () => {
    const r = await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', 'src/camera.ts', 5, 60)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines.length).toBe(MAX_SNIPPET_LINES)
    expect(r.truncated).toBe(true)
  })

  it('returns repo-not-linked for unknown repo names and unknown cases', async () => {
    expect(await readRepoSnippet(db, argusHome, 'NAV-1', 'ghost', 'src/camera.ts', 1)).toEqual({
      ok: false,
      reason: 'repo-not-linked'
    })
    expect(await readRepoSnippet(db, argusHome, 'NO-CASE', 'myrepo', 'src/camera.ts', 1)).toEqual({
      ok: false,
      reason: 'repo-not-linked'
    })
  })

  it('rejects traversal and absolute relPaths as not-found', async () => {
    expect(await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', '../outside.txt', 1)).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(
      await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', path.join(tmp, 'x.txt'), 1)
    ).toEqual({ ok: false, reason: 'not-found' })
    expect(await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', 'src/nope.ts', 1)).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('rejects backslash traversal relPaths as not-found', async () => {
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret\n')
    expect(
      await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', '..\\..\\outside.txt', 1)
    ).toEqual({ ok: false, reason: 'not-found' })
    expect(await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', '..\\outside.txt', 1)).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })

  it('reads from the worktree once one exists', async () => {
    const wt = await ensureWorktree(argusHome, 'NAV-1', repo, 'main')
    fs.writeFileSync(path.join(wt, 'src', 'camera.ts'), 'worktree line 1\n')
    const r = await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', 'src/camera.ts', 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines[0]).toBe('worktree line 1')
  })
})

describe('readRepoText', () => {
  it('reads the whole file with startLine 1 for small files', async () => {
    const r = await readRepoText(db, argusHome, 'NAV-1', 'myrepo', 'src/camera.ts', 30)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.startLine).toBe(1)
    expect(r.truncated).toBe(false)
    expect(r.content).toContain('code line 60')
    expect(r.lang).toBe('typescript')
    expect(r.ref).toBe('main')
  })

  it('readRepoText windows large files around the focus line', async () => {
    const line = 'x'.repeat(80)
    fs.writeFileSync(
      path.join(repo, 'big.log'),
      Array.from({ length: 30000 }, (_, i) => `${line} ${i + 1}`).join('\n')
    )
    const r = await readRepoText(db, argusHome, 'NAV-1', 'myrepo', 'big.log', 10000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.truncated).toBe(true)
    expect(r.startLine).toBe(10000 - WINDOW_LINES_BEFORE)
    expect(r.content.split('\n')[0].endsWith(` ${10000 - WINDOW_LINES_BEFORE}`)).toBe(true)
  })

  it('degrades to repo-not-linked / not-found like the snippet read', async () => {
    expect(await readRepoText(db, argusHome, 'NAV-1', 'ghost', 'src/camera.ts', 1)).toEqual({
      ok: false,
      reason: 'repo-not-linked'
    })
    expect(await readRepoText(db, argusHome, 'NAV-1', 'myrepo', '../x', 1)).toEqual({
      ok: false,
      reason: 'not-found'
    })
  })
})
