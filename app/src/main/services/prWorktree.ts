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
 * The pull request head's SHA on the remote, or null when it cannot be read — no `origin`, an
 * unreachable remote, a head ref that no longer exists, a timeout.
 *
 * Null always means "fall through to the fetch", never "nothing to do": the probe exists to skip
 * work, and must never be able to turn a reachable PR into a silently stale worktree. Failure
 * modes therefore all land on today's path, which reports them exactly as it did before.
 *
 * `ls-remote` with an explicit ref pattern is filtered server-side under protocol v2, so this is
 * one small round-trip with no object transfer — unlike a fetch, which negotiates against the
 * remote's whole ref set.
 */
async function remoteHeadSha(
  git: (cwd: string, ...args: string[]) => Promise<string>,
  repoPath: string,
  prNumber: number
): Promise<string | null> {
  let out: string
  try {
    out = await git(repoPath, 'ls-remote', 'origin', `refs/pull/${prNumber}/head`)
  } catch {
    return null
  }
  // `<sha>\t<ref>`, or empty when the remote has no such ref.
  const sha = out.split('\n')[0]?.split('\t')[0]?.trim() ?? ''
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null
}

/**
 * Materialize a PR's head as a detached, case-scoped git worktree and return its path.
 *
 * Fetches only when it has to. An existing worktree whose HEAD already equals the remote's
 * `pull/N/head` is returned as-is, because re-entering review mode is a repeat operation and the
 * fetch is on the critical path of the mode switch (`setCaseMode` awaits it). Everything else —
 * a missing worktree, a moved head, any probe failure — takes the fetch path below, where the
 * refspec is explicit because `ensureWorktree` does not fetch on its happy path, so a
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
    const wt = casePrWorktreeDir(argusHome, caseSlug, repoPath, prNumber)

    // Probe BEFORE the network work, not after it. The old order fetched unconditionally and
    // then compared SHAs, so an unchanged PR still paid a full fetch on every review-mode entry
    // and the comparison only ever saved a local `switch` nobody can feel.
    if (fs.existsSync(wt)) {
      const [remoteSha, curSha] = await Promise.all([
        remoteHeadSha(git, repoPath, prNumber),
        git(wt, 'rev-parse', 'HEAD').catch(() => '')
      ])
      if (remoteSha && remoteSha === curSha) {
        // `refs/argus/pr/N` is what everything else calls "the PR head" — keep that true even
        // though we skipped the fetch that normally moves it. The commit is already local (it IS
        // this worktree's HEAD), so this is a pointer write, no network.
        await git(repoPath, 'update-ref', ref, remoteSha).catch(() => undefined)
        return wt
      }
    }

    const remote = await git(repoPath, 'remote', 'get-url', 'origin')
      .then(() => 'origin')
      .catch(() => {
        throw new Error(`No 'origin' remote on ${repoPath}; cannot fetch PR #${prNumber}`)
      })
    await git(repoPath, 'fetch', remote, `pull/${prNumber}/head:${ref}`, '--force')

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
