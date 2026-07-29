import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  actionsJobId,
  bucketOfCheckRun,
  bucketOfStatusContext,
  rollupOf,
  type PrCheck,
  type PrStatus
} from '../../shared/prStatus'

const execFileAsync = promisify(execFile)

/**
 * The ONLY module that spawns `gh` (spec §7: GitHub is core plumbing, reached through one
 * thin seam so multi-VCS stays possible without being built). Every caller injects a
 * `Runner`, so no test ever spawns a process.
 */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBytes?: number }
) => Promise<string>

/**
 * How much stdout a `gh` call may produce. Node's `execFile` default is **1 MB**, and exceeding
 * it kills the child and rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` — a limit nothing at
 * the call site hints at. Shipping that default made `fetch_check_logs` fail on precisely the
 * logs it exists to read, and left `CI_LOG_MAX_BYTES` truncation unreachable: any log big enough
 * to need truncating blew the buffer first. Found 2026-07-28 against a real 3.08 MB log.
 *
 * Treat an explicit `maxBuffer` as part of the same habit as this module's explicit `timeout`.
 */
const GH_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/**
 * Deliberately does NOT catch: execFile's rejection carries `.code` and `.stderr`, and
 * `prSearch.ts` already branches on `e.code === 'ENOENT'`. Wrapping the error here would
 * break that caller silently. Callers that want prose use `ghErrorText` below.
 */
export const defaultGhRunner: Runner = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: opts?.timeoutMs,
    maxBuffer: opts?.maxBytes ?? GH_MAX_BUFFER_BYTES
  })
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
  if (/part of the diff/i.test(ghErrorText(err))) return true
  // Real `gh api` (captured 2026-07-29): stderr says only "gh: Validation Failed (HTTP 422)".
  // The API's sub-errors land as a JSON body on STDOUT, and the anchor failure is identified
  // by field, not prose — `pull_request_review_thread.line` / "could not be resolved".
  const stdout = (err as { stdout?: string })?.stdout ?? ''
  if (!stdout) return false
  try {
    const body = JSON.parse(stdout) as {
      status?: string
      errors?: { field?: string }[]
    }
    return (
      body.status === '422' &&
      (body.errors ?? []).some((e) => (e.field ?? '').startsWith('pull_request_review_thread'))
    )
  } catch {
    return false
  }
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

/** Longer than GH_TIMEOUT_MS: a log is a blob download, not a metadata call. The real capture
 *  (Task 1) was 136 KB for one job, delivered as plain text after `gh` transparently followed the
 *  API's redirect to a signed blob url. */
export const GH_LOG_TIMEOUT_MS = 60_000

/**
 * A job log is the one `gh` response with no natural size bound — the capture that motivated the
 * default was 3.08 MB, and a verbose matrix job can be far larger. Well above the 2 MB the caller
 * keeps, because the whole body must be buffered before it can be tail-truncated.
 *
 * Beyond this the call still fails loudly (execFile kills the child) rather than silently
 * returning a head-truncated log. If real logs ever approach it, stream the response and keep a
 * rolling tail instead of raising the number again.
 */
export const GH_LOG_MAX_BYTES = 64 * 1024 * 1024

/** A GitHub Actions job's log, as plain text. The API redirects to a blob; `gh` follows it. */
export async function fetchJobLog(run: Runner, repo: string, jobId: number): Promise<string> {
  return run('gh', ['api', `repos/${repo}/actions/jobs/${jobId}/logs`], {
    timeoutMs: GH_LOG_TIMEOUT_MS,
    maxBytes: GH_LOG_MAX_BYTES
  })
}

export interface PrTarget {
  owner: string
  repo: string
  number: number
}

/** Stable map key. Owner and repo are lowercased because GitHub treats them case-insensitively
 *  and a binding's stored casing is whatever the user or `gh` happened to produce. */
export function prTargetKey(t: PrTarget): string {
  return `${t.owner.toLowerCase()}/${t.repo.toLowerCase()}#${t.number}`
}

/** A bare GitHub name. Anything else would be interpolated into a GraphQL string literal. */
const NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * One aliased `repository` block per target, so N pull requests cost ONE round trip (design
 * decision 2) — the whole reason the dashboard can show a dot per case at all.
 *
 * Targets are interpolated, not parameterized: GraphQL variables cannot name aliases, and a
 * per-target variable set would have to be assembled by string anyway. `owner`/`repo` are
 * therefore validated against a bare-name pattern and `number` must be an integer, because a
 * binding is user-supplied data (the manual-link field accepts a typed reference) reaching a
 * query language.
 */
export function buildPrStatusQuery(targets: PrTarget[]): string {
  const blocks = targets.map((t, i) => {
    if (!NAME_RE.test(t.owner) || !NAME_RE.test(t.repo)) {
      throw new Error(`Invalid repository name: ${t.owner}/${t.repo}`)
    }
    if (!Number.isInteger(t.number)) {
      throw new Error(`Invalid pull request number: ${t.number}`)
    }
    return `  t${i}: repository(owner: "${t.owner}", name: "${t.repo}") {
    pullRequest(number: ${t.number}) {
      number url state isDraft mergeable reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion isRequired(pullRequestNumber: ${t.number}) detailsUrl }
          ... on StatusContext { context state isRequired(pullRequestNumber: ${t.number}) targetUrl }
        } }
      } } } }
    }
  }`
  })
  return `query {\n${blocks.join('\n')}\n}`
}

interface GraphQlBody {
  data?: Record<string, { pullRequest: RawPr | null } | null>
  errors?: { path?: (string | number)[]; message: string }[]
}

interface RawPr {
  number: number
  url: string
  state: string
  isDraft: boolean
  mergeable: string
  reviewDecision: string | null
  commits: {
    nodes: { commit: { statusCheckRollup: { contexts: { nodes: (RawContext | null)[] } } | null } }[]
  }
}

interface RawContext {
  __typename: string
  name?: string
  status?: string | null
  conclusion?: string | null
  isRequired?: boolean | null
  detailsUrl?: string | null
  context?: string
  state?: string | null
  targetUrl?: string | null
}

/**
 * Contexts are mapped 1:1 and in order, NOT de-duplicated by name. Real pull requests repeat
 * check names freely — the Task 1 capture found "Semantic Pull Request" twice on one PR and 46
 * contexts under 20 distinct names on another — and each repeat is a separate run with its own
 * job id and its own verdict. Collapsing them would hide a red run behind a green one.
 *
 * Returns null when any context node is null. GraphQL reports a field-level error by nulling
 * the node it occurred on while leaving the pull request node intact (captured in
 * `fixtures/prStatus.nullNodes.json`), so the `if (!pr)` guard in the caller never fires for
 * that shape. Mapping the survivors would silently under-report — the missing node could be
 * the only red check — so the caller marks the whole target unavailable instead.
 */
function checksOf(pr: RawPr): PrCheck[] | null {
  const nodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  if (nodes.some((n) => n === null)) return null
  return (nodes as RawContext[]).map((n) => {
    if (n.__typename === 'CheckRun') {
      const url = n.detailsUrl ?? null
      return {
        name: n.name ?? '(unnamed check)',
        bucket: bucketOfCheckRun(n.status ?? null, n.conclusion ?? null),
        required: n.isRequired === true,
        url,
        jobId: actionsJobId(url)
      }
    }
    return {
      name: n.context ?? '(unnamed status)',
      bucket: bucketOfStatusContext(n.state ?? null),
      required: n.isRequired === true,
      url: n.targetUrl ?? null,
      jobId: null
    }
  })
}

function unavailable(t: PrTarget, now: string, error: string): PrStatus {
  return {
    owner: t.owner,
    repo: t.repo,
    number: t.number,
    url: `https://github.com/${t.owner}/${t.repo}/pull/${t.number}`,
    state: 'UNKNOWN',
    isDraft: false,
    mergeable: 'UNKNOWN',
    reviewDecision: null,
    rollup: 'unavailable',
    checks: [],
    fetchedAt: now,
    error
  }
}

/**
 * Every bound PR's status in one call.
 *
 * `gh` exits non-zero when GraphQL reports errors even though it still prints a body carrying
 * the targets that DID resolve, so the rejection's `stdout` is parsed before giving up (design
 * decision 5 — confirmed against the real CLI in Task 1: exit 1, full JSON on stdout, the failing
 * alias named in `errors[].path[0]`). Each target then resolves independently: one deleted PR
 * marks its own case `unavailable` and leaves every other case's real status intact. A target is
 * never silently omitted from the returned map — a missing entry would let a stale cache row
 * survive.
 */
export async function fetchPrStatuses(
  run: Runner,
  targets: PrTarget[],
  now: string
): Promise<Map<string, PrStatus>> {
  const out = new Map<string, PrStatus>()
  if (targets.length === 0) return out

  const query = buildPrStatusQuery(targets)
  let body: GraphQlBody | null = null
  let failure = ''
  try {
    body = JSON.parse(
      await run('gh', ['api', 'graphql', '-f', `query=${query}`], {
        timeoutMs: GH_TIMEOUT_MS
      })
    ) as GraphQlBody
  } catch (err) {
    failure = ghErrorText(err)
    const stdout = (err as { stdout?: string })?.stdout
    if (stdout) {
      try {
        body = JSON.parse(stdout) as GraphQlBody
      } catch {
        // not JSON — every target is unavailable with `failure` below
      }
    }
  }

  targets.forEach((t, i) => {
    const key = prTargetKey(t)
    const pr = body?.data?.[`t${i}`]?.pullRequest ?? null
    if (!pr) {
      const own = body?.errors?.find((e) => e.path?.[0] === `t${i}`)?.message
      out.set(key, unavailable(t, now, own || failure || 'No data returned for this pull request.'))
      return
    }
    const checks = checksOf(pr)
    if (checks === null) {
      // `.find`, not `.map`: GraphQL emits one error per nulled node, so a 100-check pull
      // request would otherwise write 100 identical sentences into the cache.
      const own = body?.errors?.find((e) => e.path?.[0] === `t${i}`)?.message
      out.set(
        key,
        unavailable(t, now, own || failure || 'This pull request’s checks could not be read.')
      )
      return
    }
    out.set(key, {
      owner: t.owner,
      repo: t.repo,
      number: pr.number,
      url: pr.url,
      state: (['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)
        ? pr.state
        : 'UNKNOWN') as PrStatus['state'],
      isDraft: pr.isDraft,
      mergeable: (['MERGEABLE', 'CONFLICTING'].includes(pr.mergeable)
        ? pr.mergeable
        : 'UNKNOWN') as PrStatus['mergeable'],
      reviewDecision: (pr.reviewDecision ?? null) as PrStatus['reviewDecision'],
      rollup: rollupOf(checks),
      checks,
      fetchedAt: now,
      error: null
    })
  })
  return out
}
