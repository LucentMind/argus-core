import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  MAX_SNIPPET_LINES,
  SNIPPET_AFTER,
  SNIPPET_BEFORE,
  langForPath,
  type RepoSnippetResult,
  type RepoTextResult
} from '../../shared/snippets'
import { caseWorktreeDir, listStoredWorkspaces } from './workspaces'
import { MAX_READ_BYTES, WINDOW_LINES_AFTER, WINDOW_LINES_BEFORE, readLineWindow } from './search'

const execFileAsync = promisify(execFile)

export async function currentRef(tree: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: tree
    })
    return stdout.trim()
  } catch {
    return null
  }
}

/** repoName → the tree the case sees: the case worktree if one exists, else the
 *  primary checkout (same rule as describeWorkspace). Basename match,
 *  case-insensitive, first match wins. Null when no linked repo matches. */
export function resolveRepoTree(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  repoName: string
): string | null {
  let stored
  try {
    stored = listStoredWorkspaces(db, caseSlug)
  } catch {
    return null // unknown case behaves like an unlinked repo, never throws
  }
  const match = stored.find((w) => path.basename(w.path).toLowerCase() === repoName.toLowerCase())
  if (!match) return null
  const wt = caseWorktreeDir(argusHome, caseSlug, match.path)
  return fs.existsSync(wt) ? wt : match.path
}

/** Containment-guarded absolute file path for a repo-relative path, or null.
 *  Same discipline as resolveCasePath: containment on the resolved path BEFORE
 *  any filesystem access (path.resolve collapses '..' in both separator
 *  styles), then a realpath check so symlinks can't escape the tree. */
export function resolveRepoAbs(root: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) return null
  const rootResolved = path.resolve(root)
  const target = path.resolve(rootResolved, relPath)
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null
  const realRoot = fs.realpathSync(rootResolved)
  const real = fs.realpathSync(target)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null
  return real
}

const resolveRepoFile = resolveRepoAbs

export async function readRepoSnippet(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  repoName: string,
  relPath: string,
  start: number,
  end: number = start
): Promise<RepoSnippetResult> {
  const root = resolveRepoTree(db, argusHome, caseSlug, repoName)
  if (!root) return { ok: false, reason: 'repo-not-linked' }
  const abs = resolveRepoFile(root, relPath)
  if (!abs) return { ok: false, reason: 'not-found' }
  const s = start > 0 ? start : 1
  const e = Math.max(end, s)
  const windowStart = Math.max(1, s - SNIPPET_BEFORE)
  const windowEnd = Math.min(e + SNIPPET_AFTER, windowStart + MAX_SNIPPET_LINES - 1)
  const { content, reachedEof } = readLineWindow(abs, windowStart, windowEnd)
  return {
    ok: true,
    repoName,
    relPath,
    startLine: windowStart,
    lines: content === '' ? [] : content.split('\n'),
    lang: langForPath(relPath).lang,
    eof: reachedEof,
    truncated: e + SNIPPET_AFTER > windowEnd,
    ref: await currentRef(root)
  }
}

export async function readRepoText(
  db: DatabaseSync,
  argusHome: string,
  caseSlug: string,
  repoName: string,
  relPath: string,
  focusStart: number
): Promise<RepoTextResult> {
  const root = resolveRepoTree(db, argusHome, caseSlug, repoName)
  if (!root) return { ok: false, reason: 'repo-not-linked' }
  const abs = resolveRepoFile(root, relPath)
  if (!abs) return { ok: false, reason: 'not-found' }
  const ref = await currentRef(root)
  const lang = langForPath(relPath).lang
  const stat = fs.statSync(abs)
  if (stat.size <= MAX_READ_BYTES) {
    return {
      ok: true,
      repoName,
      relPath,
      content: fs.readFileSync(abs, 'utf8'),
      startLine: 1,
      truncated: false,
      ref,
      lang
    }
  }
  const target = focusStart > 0 ? focusStart : 1
  const windowStart = Math.max(1, target - WINDOW_LINES_BEFORE)
  const windowEnd = target + WINDOW_LINES_AFTER
  const { content, reachedEof } = readLineWindow(abs, windowStart, windowEnd)
  return {
    ok: true,
    repoName,
    relPath,
    content,
    startLine: windowStart,
    truncated: windowStart > 1 || !reachedEof,
    ref,
    lang
  }
}
