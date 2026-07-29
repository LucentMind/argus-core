import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { linkWorkspace, ensureWorktree } from '../workspaces'
import { readRepoSnippet, readRepoText, resolveRepoTree, safeSha } from '../workspaceRead'
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

  // Findings cite the remote-derived repo name (the review prompt pins it), but a clone can
  // live in any folder. Found live 2026-07-29: folder `hmt-clone`, citations `HiveMindTest/...`
  // → every preview said "repo not linked". Renderer twin of this rule: reposStore.ts.
  it('matches the remote-derived repo name when the folder is named differently', async () => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/WidgetFactory.git')
    createCase(db, argusHome, { slug: 'NAV-2', title: 'remote name' })
    await linkWorkspace(db, argusHome, 'NAV-2', repo)
    expect(resolveRepoTree(db, argusHome, 'NAV-2', 'WidgetFactory')).toBe(repo)
    expect(resolveRepoTree(db, argusHome, 'NAV-2', 'widgetfactory')).toBe(repo)
    expect(resolveRepoTree(db, argusHome, 'NAV-2', 'myrepo')).toBe(repo) // basename still works
  })
})

describe('safeSha', () => {
  it('rejects git-option-shaped and non-sha strings', () => {
    expect(safeSha('--output=pwn')).toBe(false)
    expect(safeSha('HEAD')).toBe(false)
    expect(safeSha('main')).toBe(false)
    expect(safeSha('abc12')).toBe(false) // 5 chars, too short
    expect(safeSha('a'.repeat(41))).toBe(false) // 41 chars, too long
    expect(safeSha('')).toBe(false)
  })

  it('accepts valid abbreviated and full shas, any case', () => {
    expect(safeSha('a1b2c3d')).toBe(true) // 7-char lowercase hex
    expect(safeSha('a'.repeat(40))).toBe(true) // 40-char hex
    expect(safeSha('A1B2C3D')).toBe(true) // uppercase hex
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

describe('readRepoSnippet at a pinned sha', () => {
  it('reads the content as of atSha, not the working tree', async () => {
    const oldSha = git(repo, 'rev-parse', 'HEAD').trim()
    fs.writeFileSync(
      path.join(repo, 'src', 'camera.ts'),
      Array.from({ length: 60 }, (_, i) => (i === 19 ? 'REWRITTEN' : `code line ${i + 1}`)).join(
        '\n'
      ) + '\n'
    )
    git(repo, 'commit', '-am', 'c2')
    const pinned = await readRepoSnippet(
      db,
      argusHome,
      'NAV-1',
      'myrepo',
      'src/camera.ts',
      20,
      20,
      oldSha
    )
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    expect(pinned.lines.join('\n')).toContain('code line 20')
    expect(pinned.lines.join('\n')).not.toContain('REWRITTEN')
    expect(pinned.ref).toBe(oldSha.slice(0, 12))
    const live = await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', 'src/camera.ts', 20, 20)
    if (!live.ok) return
    expect(live.lines.join('\n')).toContain('REWRITTEN')
  })

  it('falls back to the live file when the sha is unknown', async () => {
    const r = await readRepoSnippet(
      db,
      argusHome,
      'NAV-1',
      'myrepo',
      'src/camera.ts',
      3,
      3,
      'feedbeefcafefeedbeefcafefeedbeefcafefeed'
    )
    expect(r.ok).toBe(true) // live-file fallback, not an error
  })

  // atSha is renderer-supplied and reaches `execFile('git', ['show', `${atSha}:...`])`
  // verbatim — a leading `-` would be parsed by git as an option instead of a revision.
  // Reject before it ever reaches git and fall back to the live file, same as an unknown sha.
  it('falls back to the live file when atSha looks like a git option', async () => {
    const r = await readRepoSnippet(
      db,
      argusHome,
      'NAV-1',
      'myrepo',
      'src/camera.ts',
      3,
      3,
      '--output=pwn'
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines.join('\n')).toContain('code line 3')
  })

  // safeRelPath (the pinned path's own containment check, separate from resolveRepoAbs) must
  // reject the same shapes the live path already rejects — an unsafe relPath at a pinned sha
  // falls through to the live-file lookup below it, which then applies its own containment and
  // lands on the same not-found result. The pinned path must never be WORSE than the live one.
  it('rejects traversal and absolute relPaths at a pinned sha, same as the live path', async () => {
    const oldSha = git(repo, 'rev-parse', 'HEAD').trim()
    expect(
      await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', '../outside.txt', 1, 1, oldSha)
    ).toEqual({ ok: false, reason: 'not-found' })
    expect(
      await readRepoSnippet(db, argusHome, 'NAV-1', 'myrepo', path.join(tmp, 'x.txt'), 1, 1, oldSha)
    ).toEqual({ ok: false, reason: 'not-found' })
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
