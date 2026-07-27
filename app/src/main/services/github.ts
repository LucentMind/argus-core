import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * The ONLY module that spawns `gh` (spec §7: GitHub is core plumbing, reached through one
 * thin seam so multi-VCS stays possible without being built). Every caller injects a
 * `Runner`, so no test ever spawns a process.
 */
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>

/**
 * Deliberately does NOT catch: execFile's rejection carries `.code` and `.stderr`, and
 * `prSearch.ts` already branches on `e.code === 'ENOENT'`. Wrapping the error here would
 * break that caller silently. Callers that want prose use `ghErrorText` below.
 */
export const defaultGhRunner: Runner = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, { timeout: opts?.timeoutMs })
  return stdout.trim()
}

/** A `gh pr view`/`gh api` round trip. A cold API call is well under this. */
export const GH_TIMEOUT_MS = 20_000

/** Human/model-facing text for a failed gh call: the API's own stderr when there is one. */
export function ghErrorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string }
  if (e?.code === 'ENOENT') return 'GitHub CLI (gh) is not installed'
  return (e?.stderr ?? '').trim() || (e as Error)?.message || String(err)
}

/**
 * GitHub rejects an inline comment whose line is not in the PR's diff hunks (HTTP 422).
 * That is a legitimate outcome for a finding anchored at context the diff does not touch,
 * so `postReviewComment` falls back to a PR-level comment rather than failing.
 */
export function isLineNotInDiff(err: unknown): boolean {
  return /part of the diff/i.test(ghErrorText(err))
}

export interface PrHead {
  /** The PR's head BRANCH name — the push target. */
  ref: string
  /** The head commit sha — the `commit_id` an inline comment must anchor to. */
  sha: string
  /** True for a PR from a fork. Pushing to it is out of scope (design decision 4). */
  isCrossRepository: boolean
}

export async function prHead(run: Runner, repo: string, number: number): Promise<PrHead> {
  const out = await run(
    'gh',
    [
      'pr',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'headRefName,headRefOid,isCrossRepository'
    ],
    { timeoutMs: GH_TIMEOUT_MS }
  )
  const j = JSON.parse(out) as {
    headRefName: string
    headRefOid: string
    isCrossRepository: boolean
  }
  return { ref: j.headRefName, sha: j.headRefOid, isCrossRepository: j.isCrossRepository }
}

function htmlUrlOf(out: string): string {
  return (JSON.parse(out) as { html_url: string }).html_url
}

/**
 * An inline review comment on `path:line` of the PR's head commit. `-F line=` (not `-f`)
 * so gh sends a JSON number; the API rejects a string there.
 */
export async function postInlineComment(
  run: Runner,
  input: {
    repo: string
    number: number
    commitId: string
    path: string
    line: number
    body: string
  }
): Promise<string> {
  const out = await run(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${input.repo}/pulls/${input.number}/comments`,
      '-f',
      `commit_id=${input.commitId}`,
      '-f',
      `path=${input.path}`,
      '-F',
      `line=${input.line}`,
      '-f',
      'side=RIGHT',
      '-f',
      `body=${input.body}`
    ],
    { timeoutMs: GH_TIMEOUT_MS }
  )
  return htmlUrlOf(out)
}

/** A PR-level (non-inline) comment. The fallback when the anchor line is not in the diff. */
export async function postIssueComment(
  run: Runner,
  input: { repo: string; number: number; body: string }
): Promise<string> {
  const out = await run(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${input.repo}/issues/${input.number}/comments`,
      '-f',
      `body=${input.body}`
    ],
    { timeoutMs: GH_TIMEOUT_MS }
  )
  return htmlUrlOf(out)
}
