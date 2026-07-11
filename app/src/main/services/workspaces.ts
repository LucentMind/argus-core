import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { WorkspaceInfo } from '../../shared/types'
import { getCase } from './caseService'
import { caseDir } from './paths'
import { updateClaudeMdWorkspaces } from './skillsDir'

const execFileAsync = promisify(execFile)

interface StoredWorkspace {
  path: string
  remote: string | null
  branch: string | null
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

export function worktreesRoot(argusHome: string): string {
  return path.join(argusHome, 'worktrees')
}

function worktreeDir(argusHome: string, caseSlug: string, repoPath: string): string {
  return path.join(worktreesRoot(argusHome), `${path.basename(repoPath)}-${caseSlug}`)
}

// --- per-repo mutex: chain promises per canonical repo path ---
const repoLocks = new Map<string, Promise<unknown>>()
async function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoPath)
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  repoLocks.set(
    key,
    run.catch(() => undefined)
  )
  return run
}

function readStored(db: DatabaseSync, caseSlug: string): StoredWorkspace[] {
  const row = db.prepare(`SELECT workspaces FROM cases WHERE slug = ?`).get(caseSlug) as
    { workspaces: string } | undefined
  if (!row) throw new Error(`Unknown case: ${caseSlug}`)
  return JSON.parse(row.workspaces) as StoredWorkspace[]
}

function writeStored(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  list: StoredWorkspace[]
): void {
  db.prepare(`UPDATE cases SET workspaces = ?, updated_at = ? WHERE slug = ?`).run(
    JSON.stringify(list),
    new Date().toISOString(),
    caseSlug
  )
  const cj = path.join(caseDir(argusHome, caseSlug), 'case.json')
  if (fs.existsSync(cj)) {
    const data = JSON.parse(fs.readFileSync(cj, 'utf8'))
    data.workspaces = list
    fs.writeFileSync(cj, JSON.stringify(data, null, 2))
  }
  updateClaudeMdWorkspaces(
    argusHome,
    caseSlug,
    list.map((w) => ({ path: w.path, branch: w.branch }))
  )
}

async function describeWorkspace(
  argusHome: string,
  caseSlug: string,
  stored: StoredWorkspace
): Promise<WorkspaceInfo> {
  const wt = worktreeDir(argusHome, caseSlug, stored.path)
  const worktreePath = fs.existsSync(wt) ? wt : null
  const tree = worktreePath ?? stored.path
  const currentRef = await git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')
  const porcelain = await git(tree, 'status', '--porcelain')
  return { ...stored, currentRef, dirty: porcelain.length > 0, worktreePath }
}

export async function linkWorkspace(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  repoPath: string
): Promise<WorkspaceInfo> {
  if (!getCase(db, caseSlug)) throw new Error(`Unknown case: ${caseSlug}`)
  try {
    await git(repoPath, 'rev-parse', '--git-dir')
  } catch {
    throw new Error(`Not a git repository: ${repoPath}`)
  }
  const branch = await git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')
  let remote: string | null = null
  try {
    remote = await git(repoPath, 'remote', 'get-url', 'origin')
  } catch {
    remote = null
  }
  const stored = readStored(db, caseSlug).filter((w) => w.path !== repoPath)
  const entry: StoredWorkspace = { path: repoPath, remote, branch }
  writeStored(db, argusHome, caseSlug, [...stored, entry])
  return describeWorkspace(argusHome, caseSlug, entry)
}

export async function unlinkWorkspace(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  repoPath: string
): Promise<void> {
  await withRepoLock(repoPath, async () => {
    const wt = worktreeDir(argusHome, caseSlug, repoPath)
    if (fs.existsSync(wt)) {
      await git(repoPath, 'worktree', 'remove', '--force', wt)
      await git(repoPath, 'worktree', 'prune')
    }
  })
  writeStored(
    db,
    argusHome,
    caseSlug,
    readStored(db, caseSlug).filter((w) => w.path !== repoPath)
  )
}

export async function listWorkspaces(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string
): Promise<WorkspaceInfo[]> {
  const out: WorkspaceInfo[] = []
  for (const s of readStored(db, caseSlug))
    out.push(await describeWorkspace(argusHome, caseSlug, s))
  return out
}

export async function ensureWorktree(
  argusHome: string,
  caseSlug: string,
  repoPath: string,
  ref: string
): Promise<string> {
  return withRepoLock(repoPath, async () => {
    const wt = worktreeDir(argusHome, caseSlug, repoPath)
    if (fs.existsSync(wt)) {
      // Check if already at the requested ref; if so, skip switching to avoid detaching
      const current = await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')
      if (current === ref) return wt

      const [curSha, refSha] = await Promise.all([
        git(wt, 'rev-parse', 'HEAD'),
        git(wt, 'rev-parse', '--verify', `${ref}^{commit}`).catch(() => '')
      ])
      if (refSha && curSha === refSha) return wt

      await git(wt, 'switch', '--detach', ref).catch(async () => git(wt, 'switch', ref))
      return wt
    }
    fs.mkdirSync(worktreesRoot(argusHome), { recursive: true })
    try {
      await git(repoPath, 'worktree', 'add', wt, ref)
    } catch (err) {
      const msg = String(
        (err as { message?: string; stderr?: string })?.stderr ?? (err as Error)?.message ?? ''
      )
      if (/already used by worktree|already checked out/i.test(msg)) {
        // ref is checked out elsewhere (e.g. the primary checkout) — materialize
        // a detached checkout instead of stealing the branch from that worktree.
        await git(repoPath, 'worktree', 'add', '--detach', wt, ref)
      } else {
        await git(repoPath, 'fetch', '--all')
        await git(repoPath, 'worktree', 'add', wt, ref)
      }
    }
    return wt
  })
}

export async function workspaceSandboxRoots(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string
): Promise<string[]> {
  return [...readStored(db, caseSlug).map((w) => w.path), worktreesRoot(argusHome)]
}

/** Auto-link the settings-default repo at case creation. Best-effort:
 *  failures (missing dir, not a git repo) warn-log and never block creation. */
export async function autoLinkDefaultRepo(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  defaultRepo: string | null
): Promise<void> {
  if (!defaultRepo) return
  try {
    await linkWorkspace(db, argusHome, caseSlug, defaultRepo)
  } catch (err) {
    console.warn(`[workspaces] default-repo auto-link failed: ${(err as Error).message}`)
  }
}
