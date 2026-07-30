import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { withRepoLock, worktreesRoot } from './workspaces'

const execFileAsync = promisify(execFile)

// workspaces.ts's own git helper passes no timeout; every call here is explicit, per the
// subprocess constraint. Fetching a PR head from a cold remote is the slow one.
const GIT_TIMEOUT_MS = 60_000

/**
 * One git invocation, returning trimmed stdout. Injected rather than called directly so a test
 * can record argv while still running the REAL git — the claim worth proving here is "no fetch
 * happened", and no filesystem post-condition distinguishes a skipped fetch from a fetch that
 * transferred nothing. A fake git would prove nothing about git.
 */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>

const realGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS })
  return stdout.trim()
}

/**
 * A PR's worktree directory. Distinct from `caseWorktreeDir`, which carries no ref
 * component: reusing it would make an investigation-mode branch checkout and a
 * review-mode PR checkout fight over one directory, switching refs under each other.
 */
export function casePrWorktreeDir(
  argusHome: string,
  caseSlug: string,
  repoPath: string,
  prNumber: number
): string {
  return path.join(worktreesRoot(argusHome), `${path.basename(repoPath)}-${caseSlug}-pr${prNumber}`)
}

/** The local ref a fetched PR head lands on — namespaced so nothing relies on FETCH_HEAD. */
function prRef(prNumber: number): string {
  return `refs/argus/pr/${prNumber}`
}

/**
 * Materialize a PR's head as a detached, case-scoped git worktree and return its path.
 *
 * The fetch is explicit because `ensureWorktree` does not fetch on its happy path, so a
 * `pull/N/head` ref that was never fetched would simply not resolve.
 */
export async function ensurePrWorktree(
  argusHome: string,
  caseSlug: string,
  repoPath: string,
  prNumber: number,
  deps?: { run?: GitRunner }
): Promise<string> {
  const run = deps?.run ?? realGit
  const git = (cwd: string, ...args: string[]): Promise<string> => run(cwd, args)
  return withRepoLock(repoPath, async () => {
    const ref = prRef(prNumber)
    const remote = await git(repoPath, 'remote', 'get-url', 'origin')
      .then(() => 'origin')
      .catch(() => {
        throw new Error(`No 'origin' remote on ${repoPath}; cannot fetch PR #${prNumber}`)
      })
    await git(repoPath, 'fetch', remote, `pull/${prNumber}/head:${ref}`, '--force')

    const wt = casePrWorktreeDir(argusHome, caseSlug, repoPath, prNumber)
    if (fs.existsSync(wt)) {
      // Mirrors ensureWorktree's early return: only switch when the head actually moved.
      const [curSha, refSha] = await Promise.all([
        git(wt, 'rev-parse', 'HEAD'),
        git(wt, 'rev-parse', '--verify', `${ref}^{commit}`).catch(() => '')
      ])
      if (refSha && curSha !== refSha) await git(wt, 'switch', '--detach', ref)
      return wt
    }
    fs.mkdirSync(worktreesRoot(argusHome), { recursive: true })
    await git(repoPath, 'worktree', 'add', '--detach', wt, ref)
    return wt
  })
}
