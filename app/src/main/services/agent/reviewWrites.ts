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
import { type Runner } from '../github'

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
  const bindings = listBindings(deps.db, caseSlug)
  if (bindings.length === 0) throw new Error(wf(deps, 'review_write.no-binding'))

  const slash = row.diff_path.indexOf('/')
  const head = slash > 0 ? row.diff_path.slice(0, slash) : ''
  const rest = slash > 0 ? row.diff_path.slice(slash + 1) : row.diff_path
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
        path: row.diff_path,
        repos: bindings.map((b) => b.repo).join(', ')
      })
    )
  }

  const binding = named ?? bindings[0]
  const repoRelPath = named ? rest : row.diff_path
  const worktree = worktreeFor(deps, caseSlug, binding)
  if (worktree && !fs.existsSync(path.join(worktree, repoRelPath))) {
    throw new Error(wf(deps, 'review_write.path-missing', { path: repoRelPath, worktree }))
  }
  return { binding, repoRelPath, line: row.diff_line, worktree }
}
