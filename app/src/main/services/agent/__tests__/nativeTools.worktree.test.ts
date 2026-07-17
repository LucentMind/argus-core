import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { createDetection } from '../../packs/detection'
import { linkWorkspace } from '../../workspaces'
import { argusToolHandlers } from '../nativeTools'
import type { DatabaseSync } from 'node:sqlite'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let tmp: string, argusHome: string, repo: string, db: DatabaseSync, caseId: number
const detection = createDetection()

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ntwt-'))
  argusHome = path.join(tmp, 'home')
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
  const rec = createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
  caseId = rec.id
  await linkWorkspace(db, argusHome, 'NAV-1', repo)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('workspace_checkout renderer notification', () => {
  it('fires onWorktreeChanged with the case slug after materializing a worktree', async () => {
    const onWorktreeChanged = vi.fn()
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId,
      caseSlug: 'NAV-1',
      sessionId: 1,
      emitFinding: vi.fn(),
      onWorktreeChanged
    })
    const out = await handlers.workspace_checkout({ repo_path: repo, ref: 'feature/x' })
    expect(out).toContain('feature/x')
    expect(onWorktreeChanged).toHaveBeenCalledWith('NAV-1')
  })

  it('does not fire when checkout fails', async () => {
    const onWorktreeChanged = vi.fn()
    const handlers = argusToolHandlers({
      db,
      argusHome,
      detection,
      caseId,
      caseSlug: 'NAV-1',
      sessionId: 1,
      emitFinding: vi.fn(),
      onWorktreeChanged
    })
    await expect(
      handlers.workspace_checkout({ repo_path: repo, ref: 'no-such-ref' })
    ).rejects.toThrow()
    expect(onWorktreeChanged).not.toHaveBeenCalled()
  })
})
