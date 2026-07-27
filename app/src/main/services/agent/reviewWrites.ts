import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { parsePrRef, type PrBinding } from '../../../shared/pr'
import type { PromptTextSpecs } from '../../../shared/promptSpec'
import { fillPrompt } from '../prompts/fill'
import { getBinding } from '../prBindings'
import { casePrWorktreeDir } from '../prWorktree'
import {
  defaultGhRunner,
  ghErrorText,
  isLineNotInDiff,
  postInlineComment,
  postIssueComment,
  prHead,
  type Runner
} from '../github'
import { recordFindingWrite } from '../findings'

const execFileAsync = promisify(execFile)

/** git needs a cwd, so it gets its own runner shape rather than reusing gh's. */
export type GitRunner = (
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<string>

export const defaultGitRunner: GitRunner = async (cwd, args, opts) => {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: opts?.timeoutMs })
  return stdout.trim()
}

export interface ReviewWriteDeps {
  db: DatabaseSync
  argusHome: string
  /** Injected in tests; production passes `defaultGhRunner`. */
  gh?: Runner
  git?: GitRunner
  /** Prompt-registry resolver for `REVIEW_WRITE_FEEDBACK`. */
  resolve?: (id: string) => string
}

/**
 * Model-facing text the two write tools THROW. Registered as `tool-feedback.*` like every
 * other string a native tool returns to the agent (`nativeTools.ts` TOOL_FEEDBACK).
 */
export const REVIEW_WRITE_FEEDBACK: PromptTextSpecs = {
  'review_write.unknown-finding': {
    title: 'review writes — unknown finding',
    // Deliberately identical for EVERY bad id, not just "no such id" vs. "belongs to another
    // case": an agent must not be able to probe finding ids across cases by diffing error
    // text, so unlike `no-anchor` below this one does not echo the id back. Same posture as
    // `Unknown evidence_id`, minus the echo.
    text: 'Unknown finding id.'
  },
  'review_write.no-anchor': {
    title: 'review writes — finding has no diff anchor',
    text: 'Finding {id} has no diff anchor, so it cannot be an inline comment. Re-record it with a [<repo-name>/<path>:<line>] citation into the changed lines.',
    placeholders: ['id']
  },
  'review_write.no-binding': {
    title: 'review writes — no pull request bound',
    text: 'No pull request is bound to this case, so there is nothing to write to.'
  },
  'review_write.path-missing': {
    title: 'review writes — anchor path not in the worktree',
    text: '{path} does not exist in the PR worktree at {worktree}. Cite a path inside the reviewed repo.',
    placeholders: ['path', 'worktree']
  },
  'review_write.unknown-pr': {
    title: 'review writes — named pull request is not bound',
    text: '{pr} is not one of the pull requests bound to this case ({bound}). Pass pr as owner/repo#number for a pull request that is actually bound here.',
    placeholders: ['pr', 'bound']
  },
  'review_write.unsafe-path': {
    title: 'review writes — citation path escapes the repo',
    text: '{path} is not a safe repo-relative path (absolute, or containing "..") and cannot be published. Re-record the finding with a repo-relative [<repo-name>/<path>:<line>] citation.',
    placeholders: ['path']
  },
  'review_write.empty-body': {
    title: 'review writes — empty comment body',
    text: 'The comment body is empty. Write the text to post before calling post_review_comment.'
  },
  'review_write.empty-commit-message': {
    title: 'review writes — empty commit message',
    text: "The commit message is empty. Write one in the repository's existing style before calling push_review_change."
  },
  'review_write.no-worktree': {
    title: 'review writes — PR has no local checkout',
    text: 'PR #{number} has no local checkout, so there is nothing to commit or push. Re-enter review mode to materialize it.',
    placeholders: ['number']
  },
  'review_write.fork': {
    title: 'review writes — PR is from a fork',
    text: 'PR #{number} is from a fork ({repo}); Argus does not push to fork branches. Post a comment with the suggested change instead.',
    placeholders: ['number', 'repo']
  },
  'review_write.nothing-to-push': {
    title: 'review writes — worktree is clean',
    text: 'The PR worktree has no uncommitted changes. Apply the change first, then push.'
  },
  'review_write.stale-worktree': {
    title: 'review writes — worktree is behind the PR',
    text: "The PR worktree is behind PR #{number}'s head ({sha}). Re-enter review mode to refresh it, redo the change, then push.",
    placeholders: ['number', 'sha']
  },
  'review_write.comment-ok': {
    title: 'review writes — comment posted',
    text: 'Comment posted: {url}',
    placeholders: ['url']
  },
  'review_write.comment-not-inline': {
    title: 'review writes — posted as a PR-level comment',
    text: 'Line {line} of {path} is not part of the diff, so this was posted as a PR-level comment instead: {url}',
    placeholders: ['line', 'path', 'url']
  },
  'review_write.push-ok': {
    title: 'review writes — pushed',
    text: 'Pushed {sha} to {ref} on PR #{number}.',
    placeholders: ['sha', 'ref', 'number']
  }
}

/** Resolve one feedback string, filled. No resolver = the shipped default. */
export function wf(deps: ReviewWriteDeps, key: string, vars: Record<string, string> = {}): string {
  const text = deps.resolve ? deps.resolve(`tool-feedback.${key}`) : REVIEW_WRITE_FEEDBACK[key].text
  return fillPrompt(text, vars)
}

interface FindingAnchorRow {
  id: number
  diff_path: string | null
  diff_line: number | null
  summary: string
  suggested_change: string | null
}

/** Case-scoped by construction: the join is the ownership check. */
export function findingForCase(
  deps: ReviewWriteDeps,
  caseSlug: string,
  findingId: number
): FindingAnchorRow {
  const row = deps.db
    .prepare(
      `SELECT f.id, f.diff_path, f.diff_line, f.summary, f.suggested_change
         FROM findings f JOIN cases c ON c.id = f.case_id
        WHERE c.slug = ? AND f.id = ?`
    )
    .get(caseSlug, findingId) as FindingAnchorRow | undefined
  if (!row) throw new Error(wf(deps, 'review_write.unknown-finding'))
  return row
}

export interface CommentTarget {
  binding: PrBinding
  /** Repo-relative — the citation's `<repo-name>/` prefix stripped when it was present. */
  repoRelPath: string
  line: number
  /** The materialized PR worktree, when there is one. */
  worktree: string | null
}

/** The worktree for a binding, or null when the PR has no local clone / was never checked out. */
export function worktreeFor(
  deps: ReviewWriteDeps,
  caseSlug: string,
  binding: PrBinding
): string | null {
  if (!binding.repoPath) return null
  const wt = casePrWorktreeDir(deps.argusHome, caseSlug, binding.repoPath, binding.number)
  return fs.existsSync(wt) ? wt : null
}

/**
 * Parse `pr` into `{owner, repo, number}`. The composed prompt tells the agent `owner/repo#number`
 * (reviewActions.ts), but reuses `shared/pr.ts`'s `parsePrRef` rather than a bespoke regex — it
 * already accepts that form AND a full PR url (the exact string the prompt hands the agent to
 * derive `owner/repo#number` FROM, so an agent that pastes the url back verbatim still resolves
 * instead of failing closed on a technicality). No `fallbackRemote` is passed, so the bare-`#N`
 * form `parsePrRef` also accepts is correctly refused here — there is no "current repo" to
 * resolve a bare number against in this context, and a bare number silently matching the wrong
 * repo would defeat the whole point of `pr`.
 */
function parseExpectPr(v: string): { owner: string; repo: string; number: number } | null {
  return parsePrRef(v)
}

function sameBindingIdentity(
  b: PrBinding,
  want: { owner: string; repo: string; number: number }
): boolean {
  return (
    b.owner.toLowerCase() === want.owner.toLowerCase() &&
    b.repo.toLowerCase() === want.repo.toLowerCase() &&
    b.number === want.number
  )
}

/** A binding as the `owner/repo#number` the model is told to pass back as `pr` — used by
 *  `unknown-pr`'s `{bound}` placeholder so the model can copy a value straight out of the
 *  error text into `pr` without having to reconstruct `owner/repo` itself. */
function prIdentity(b: PrBinding): string {
  return `${b.owner}/${b.repo}#${b.number}`
}

/**
 * The pull request a finding belongs to: the case's one binding (see prBindings.getBinding and
 * the unique index in db.ts). `expectPr`, when the model supplies it, is a CHECK — it must name
 * that binding — not a selector; naming any other PR throws (`unknown-pr`) rather than
 * retargeting the write. There is nothing left to disambiguate: with exactly one binding, a
 * citation's `<repo-name>/` prefix can only ever agree with it or name something else entirely,
 * so the old citation-prefix search and the `pr`-contradicts-citation guard both have no case
 * left to catch — see resolveCommentTarget for the (now unconditional) prefix strip.
 */
function resolveBindingForFinding(
  deps: ReviewWriteDeps,
  caseSlug: string,
  expectPr?: string
): PrBinding {
  const binding = getBinding(deps.db, caseSlug)
  if (!binding) throw new Error(wf(deps, 'review_write.no-binding'))
  if (expectPr) {
    const wanted = parseExpectPr(expectPr)
    if (!wanted || !sameBindingIdentity(binding, wanted)) {
      throw new Error(
        wf(deps, 'review_write.unknown-pr', { pr: expectPr, bound: prIdentity(binding) })
      )
    }
  }
  return binding
}

/**
 * A finding's `(PR, repo-relative path, line)`. The citation grammar the review persona is
 * told to use is `[<repo-name>/<path>:<line>]` (reviewRun.ts's triage step), but GitHub wants
 * a repo-relative path — so the first segment is stripped when it names the reviewed repo.
 * A materialized worktree turns that strip from a guess into a verified fact.
 */
export function resolveCommentTarget(
  deps: ReviewWriteDeps,
  caseSlug: string,
  findingId: number,
  expectPr?: string
): CommentTarget {
  const row = findingForCase(deps, caseSlug, findingId)
  if (!row.diff_path || row.diff_line === null) {
    throw new Error(wf(deps, 'review_write.no-anchor', { id: String(findingId) }))
  }
  const binding = resolveBindingForFinding(deps, caseSlug, expectPr)

  // The prefix names the binding's repo when it matches either the GitHub repo name or the
  // local clone's directory name (a clone can be checked out under a different name).
  const slash = row.diff_path.indexOf('/')
  const head = slash > 0 ? row.diff_path.slice(0, slash) : ''
  const named =
    head !== '' &&
    (binding.repo.toLowerCase() === head.toLowerCase() ||
      (binding.repoPath !== null &&
        path.basename(binding.repoPath).toLowerCase() === head.toLowerCase()))
  const rest = slash > 0 ? row.diff_path.slice(slash + 1) : row.diff_path
  const repoRelPath = named ? rest : row.diff_path
  // The review-run header hands the agent the ABSOLUTE worktree path; an absolute or
  // traversal-carrying citation would otherwise reach GitHub verbatim — inline via a path the
  // API happens to reject, or PR-level via the fallback body's `**{path}:{line}**` text, which
  // has no such check. Enforced unconditionally, not just when a worktree exists to check
  // against: an unmaterialized worktree must not turn into a free pass for the leak.
  if (path.isAbsolute(repoRelPath) || repoRelPath.split(/[\\/]/).includes('..')) {
    throw new Error(wf(deps, 'review_write.unsafe-path', { path: repoRelPath }))
  }
  const worktree = worktreeFor(deps, caseSlug, binding)
  if (worktree && !fs.existsSync(path.join(worktree, repoRelPath))) {
    throw new Error(wf(deps, 'review_write.path-missing', { path: repoRelPath, worktree }))
  }
  return { binding, repoRelPath, line: row.diff_line, worktree }
}

/**
 * Post a finding as an inline PR review comment on its diff anchor.
 *
 * GitHub rejects an inline comment whose line is not in the diff's hunks (HTTP 422). That is a
 * legitimate outcome — a finding may cite context the diff only reads — so we retry once as a
 * PR-level comment carrying the `path:line` in its body, rather than failing the write. Any
 * other gh failure propagates untouched and NOTHING is recorded on the finding.
 *
 * `input.expectPr`, when supplied, is the `owner/repo#number` the model was told to copy from
 * the composed prompt: it both makes the approval card name the target PR (it is part of the
 * tool's `input`, so it lands in `argsPreview` for free) and is a CHECK, not just a display —
 * `resolveCommentTarget` throws `unknown-pr` if it names a PR that is not actually bound here.
 *
 * `recordFindingWrite` deliberately sits OUTSIDE the try/catch below: it runs only after a `gh`
 * call has already succeeded, so a failure there (e.g. a SQLite error) must propagate as itself,
 * not get reclassified as a `gh` failure via `ghErrorText` — that used to tell the model the post
 * had failed while the comment was actually live on the PR, and a retry would duplicate it.
 */
export async function postReviewComment(
  deps: ReviewWriteDeps,
  caseSlug: string,
  input: { findingId: number; body: string; expectPr?: string }
): Promise<string> {
  if (!input.body.trim()) throw new Error(wf(deps, 'review_write.empty-body'))
  const target = resolveCommentTarget(deps, caseSlug, input.findingId, input.expectPr)
  const run = deps.gh ?? defaultGhRunner
  const repo = `${target.binding.owner}/${target.binding.repo}`
  const head = await prHead(run, repo, target.binding.number)

  let url: string
  let inline = true
  try {
    url = await postInlineComment(run, {
      repo,
      number: target.binding.number,
      commitId: head.sha,
      path: target.repoRelPath,
      line: target.line,
      body: input.body
    })
  } catch (err) {
    if (!isLineNotInDiff(err)) throw new Error(ghErrorText(err))
    inline = false
    url = await postIssueComment(run, {
      repo,
      number: target.binding.number,
      body: `**${target.repoRelPath}:${target.line}**\n\n${input.body}`
    })
  }

  recordFindingWrite(deps.db, input.findingId, { commentUrl: url })
  return inline
    ? wf(deps, 'review_write.comment-ok', { url })
    : wf(deps, 'review_write.comment-not-inline', {
        line: String(target.line),
        path: target.repoRelPath,
        url
      })
}

/** A push over a cold remote is the slow one here; commit/status are instant. */
const GIT_PUSH_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 30_000

/**
 * `git merge-base --is-ancestor` exits 1 specifically for "not an ancestor" — every other
 * non-zero exit (a timeout, an unresolvable sha) is a real error and must not be reported as
 * staleness, which would send the user to "re-enter review mode" for an unrelated problem.
 */
function gitExitCode(err: unknown): number | string | undefined {
  return (err as { code?: number | string } | undefined)?.code
}

/**
 * Commit the PR worktree and push it to the PR's head branch (spec §6's HIGH write).
 *
 * The worktree is checked out DETACHED at `refs/argus/pr/<n>` (prWorktree.ts), so there is no
 * upstream to infer — the refspec is explicit. Never `--force`: a non-fast-forward rejection
 * is git's answer to a race we must not win, and it is surfaced verbatim.
 *
 * Guards run in cost order and each fails before the next does any work: an empty commit
 * message, ownership, binding resolution (which PR — see `resolveBindingForFinding`, and now
 * also where `input.expectPr` is verified against what is actually bound), a local checkout,
 * fork, and staleness. Staleness is checked before "is there anything to do" because that
 * answer needs the ancestry check anyway (a clean worktree that is ahead of the PR head still
 * has something to push — see below) — a stale worktree that somehow fast-forwards would
 * silently drop commits pushed to the PR since we fetched it.
 *
 * Commit and push are separate steps rather than one atomic "commit-then-push": if a previous
 * call committed locally but the push itself failed (rejected, network drop), the worktree is
 * clean AND ahead of the last-seen PR head. Re-running must not mistake that for "nothing to
 * do" (the dirty-tree guard) — it commits nothing and retries only the push.
 */
export async function pushReviewChange(
  deps: ReviewWriteDeps,
  caseSlug: string,
  input: { findingId: number; commitMessage: string; expectPr?: string }
): Promise<string> {
  if (!input.commitMessage.trim()) {
    throw new Error(wf(deps, 'review_write.empty-commit-message'))
  }
  findingForCase(deps, caseSlug, input.findingId) // ownership; throws unknown-finding
  const binding = resolveBindingForFinding(deps, caseSlug, input.expectPr)
  const worktree = worktreeFor(deps, caseSlug, binding)
  if (!worktree) {
    throw new Error(wf(deps, 'review_write.no-worktree', { number: String(binding.number) }))
  }

  const repo = `${binding.owner}/${binding.repo}`
  const head = await prHead(deps.gh ?? defaultGhRunner, repo, binding.number)
  if (head.isCrossRepository) {
    throw new Error(wf(deps, 'review_write.fork', { number: String(binding.number), repo }))
  }

  const git = deps.git ?? defaultGitRunner

  try {
    await git(worktree, ['merge-base', '--is-ancestor', head.sha, 'HEAD'], {
      timeoutMs: GIT_TIMEOUT_MS
    })
  } catch (err) {
    if (gitExitCode(err) !== 1) throw err
    throw new Error(
      wf(deps, 'review_write.stale-worktree', {
        number: String(binding.number),
        sha: head.sha.slice(0, 12)
      })
    )
  }

  let sha = await git(worktree, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
  const dirty = await git(worktree, ['status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS })

  if (!dirty.trim() && sha === head.sha) {
    throw new Error(wf(deps, 'review_write.nothing-to-push'))
  }

  if (dirty.trim()) {
    await git(worktree, ['add', '-A'], { timeoutMs: GIT_TIMEOUT_MS })
    await git(worktree, ['commit', '-m', input.commitMessage], { timeoutMs: GIT_TIMEOUT_MS })
    sha = await git(worktree, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
  }

  await git(worktree, ['push', 'origin', `HEAD:refs/heads/${head.ref}`], {
    timeoutMs: GIT_PUSH_TIMEOUT_MS
  })

  recordFindingWrite(deps.db, input.findingId, { pushedSha: sha })
  return wf(deps, 'review_write.push-ok', {
    sha,
    ref: head.ref,
    number: String(binding.number)
  })
}
