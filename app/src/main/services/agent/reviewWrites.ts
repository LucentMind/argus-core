import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import type { PrBinding } from '../../../shared/pr'
import type { PromptTextSpecs } from '../../../shared/promptSpec'
import { fillPrompt } from '../prompts/fill'
import { listBindings } from '../prBindings'
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
  'review_write.ambiguous-binding': {
    title: 'review writes — cannot tell which PR the finding belongs to',
    text: 'This case has {count} bound pull requests and {path} does not name any of them ({repos}). Re-record the finding with a [<repo-name>/<path>:<line>] citation so the pull request is unambiguous.',
    placeholders: ['count', 'path', 'repos']
  },
  'review_write.uncited-ambiguous': {
    title: 'review writes — uncited finding, several bound PRs',
    text: 'This case has {count} bound pull requests and this finding carries no citation, so there is no way to tell which one it belongs to ({repos}). Re-record it with a [<repo-name>/<path>:<line>] citation.',
    placeholders: ['count', 'repos']
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
 * Which bound PR a finding belongs to, from its citation's `<repo-name>/` prefix (if any).
 * Shared by the comment path (which then strips the prefix and verifies the path exists in
 * the worktree) and the push path (which needs neither — push's whole point can be deleting or
 * renaming the cited file, and it has no anchor requirement to begin with).
 *
 * A null `diffPath` still resolves when there is exactly one binding: only the multi-binding
 * case needs the citation to disambiguate. `named` tells the caller whether the prefix actually
 * matched a binding (vs. falling back to the sole one).
 */
function resolveBindingForFinding(
  deps: ReviewWriteDeps,
  caseSlug: string,
  diffPath: string | null
): { binding: PrBinding; named: boolean } {
  const bindings = listBindings(deps.db, caseSlug)
  if (bindings.length === 0) throw new Error(wf(deps, 'review_write.no-binding'))

  if (diffPath === null) {
    if (bindings.length > 1) {
      throw new Error(
        wf(deps, 'review_write.uncited-ambiguous', {
          count: String(bindings.length),
          repos: bindings.map((b) => b.repo).join(', ')
        })
      )
    }
    return { binding: bindings[0], named: false }
  }

  const slash = diffPath.indexOf('/')
  const head = slash > 0 ? diffPath.slice(0, slash) : ''
  const named = head
    ? bindings.find(
        (b) =>
          b.repo.toLowerCase() === head.toLowerCase() ||
          (b.repoPath !== null && path.basename(b.repoPath).toLowerCase() === head.toLowerCase())
      )
    : undefined

  if (!named && bindings.length > 1) {
    throw new Error(
      wf(deps, 'review_write.ambiguous-binding', {
        count: String(bindings.length),
        path: diffPath,
        repos: bindings.map((b) => b.repo).join(', ')
      })
    )
  }

  return { binding: named ?? bindings[0], named: named !== undefined }
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
  findingId: number
): CommentTarget {
  const row = findingForCase(deps, caseSlug, findingId)
  if (!row.diff_path || row.diff_line === null) {
    throw new Error(wf(deps, 'review_write.no-anchor', { id: String(findingId) }))
  }
  const { binding, named } = resolveBindingForFinding(deps, caseSlug, row.diff_path)

  const slash = row.diff_path.indexOf('/')
  const rest = slash > 0 ? row.diff_path.slice(slash + 1) : row.diff_path
  const repoRelPath = named ? rest : row.diff_path
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
 */
export async function postReviewComment(
  deps: ReviewWriteDeps,
  caseSlug: string,
  input: { findingId: number; body: string }
): Promise<string> {
  const target = resolveCommentTarget(deps, caseSlug, input.findingId)
  const run = deps.gh ?? defaultGhRunner
  const repo = `${target.binding.owner}/${target.binding.repo}`
  const head = await prHead(run, repo, target.binding.number)

  try {
    const url = await postInlineComment(run, {
      repo,
      number: target.binding.number,
      commitId: head.sha,
      path: target.repoRelPath,
      line: target.line,
      body: input.body
    })
    recordFindingWrite(deps.db, input.findingId, { commentUrl: url })
    return wf(deps, 'review_write.comment-ok', { url })
  } catch (err) {
    if (!isLineNotInDiff(err)) throw new Error(ghErrorText(err))
    const url = await postIssueComment(run, {
      repo,
      number: target.binding.number,
      body: `**${target.repoRelPath}:${target.line}**\n\n${input.body}`
    })
    recordFindingWrite(deps.db, input.findingId, { commentUrl: url })
    return wf(deps, 'review_write.comment-not-inline', {
      line: String(target.line),
      path: target.repoRelPath,
      url
    })
  }
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
 * Guards run in cost order and each fails before the next does any work: ownership, a local
 * checkout, fork, and staleness. Staleness is checked before "is there anything to do" because
 * that answer needs the ancestry check anyway (a clean worktree that is ahead of the PR head
 * still has something to push — see below) — a stale worktree that somehow fast-forwards would
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
  input: { findingId: number; commitMessage: string }
): Promise<string> {
  const row = findingForCase(deps, caseSlug, input.findingId) // ownership; throws unknown-finding
  const { binding } = resolveBindingForFinding(deps, caseSlug, row.diff_path)
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
