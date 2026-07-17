import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { TextDocSource, TextDocOpenResult, TextDocLines } from '../../shared/textdoc'
import { textDocKey } from '../../shared/textdoc'
import { langForPath } from '../../shared/snippets'
import { MAX_READ_BYTES } from './search'
import { caseDir } from './paths'
import { resolveRepoTree, resolveRepoAbs, currentRef } from './workspaceRead'
import { ensureIndex, getLines } from './lineIndex'

type Resolved =
  | {
      abs: string
      title: string
      lang: string | null
      caseSlug?: string
      relPath?: string
      root?: string
    }
  | { error: 'repo-not-linked' | 'not-found' }

export function resolveTextDocAbs(
  db: DatabaseSync,
  argusHome: string,
  source: TextDocSource
): Resolved {
  if (source.kind === 'evidence') {
    const row = db
      .prepare(
        `SELECT e.rel_path AS relPath, c.slug AS caseSlug
         FROM evidence e JOIN cases c ON c.id = e.case_id WHERE e.id = ?`
      )
      .get(source.evidenceId) as { relPath: string; caseSlug: string } | undefined
    if (!row) return { error: 'not-found' }
    const abs = path.join(caseDir(argusHome, row.caseSlug), row.relPath)
    if (!fs.existsSync(abs)) return { error: 'not-found' }
    return {
      abs,
      title: `${row.caseSlug} / ${row.relPath}`,
      lang: langForPath(row.relPath).lang,
      caseSlug: row.caseSlug,
      relPath: row.relPath
    }
  }
  const root = resolveRepoTree(db, argusHome, source.caseSlug, source.repoName)
  if (!root) return { error: 'repo-not-linked' }
  const abs = resolveRepoAbs(root, source.relPath)
  if (!abs) return { error: 'not-found' }
  return {
    abs,
    title: `${source.repoName} / ${source.relPath}`,
    lang: langForPath(source.relPath).lang,
    root
  }
}

export async function openTextDoc(
  db: DatabaseSync,
  argusHome: string,
  source: TextDocSource,
  onProgress?: (key: string, fraction: number) => void
): Promise<TextDocOpenResult> {
  const res = resolveTextDocAbs(db, argusHome, source)
  if ('error' in res) return { ok: false, reason: res.error }
  const ref = res.root ? await currentRef(res.root) : null
  const stat = fs.statSync(res.abs)
  const common = {
    ok: true as const,
    title: res.title,
    lang: res.lang,
    ref,
    caseSlug: res.caseSlug,
    relPath: res.relPath,
    evidenceId: source.kind === 'evidence' ? source.evidenceId : undefined
  }
  if (stat.size <= MAX_READ_BYTES) {
    const whole = fs.readFileSync(res.abs, 'utf8')
    let totalLines = 0
    for (let i = 0; i < whole.length; i++) if (whole.charCodeAt(i) === 10) totalLines++
    if (whole.length > 0 && whole.charCodeAt(whole.length - 1) !== 10) totalLines++
    return { ...common, totalLines, whole }
  }
  const key = textDocKey(source)
  const index = await ensureIndex(argusHome, res.abs, (f) => onProgress?.(key, f))
  return { ...common, totalLines: index.totalLines }
}

export async function readTextDocLines(
  db: DatabaseSync,
  argusHome: string,
  source: TextDocSource,
  from: number,
  to: number
): Promise<TextDocLines> {
  const res = resolveTextDocAbs(db, argusHome, source)
  if ('error' in res) return { from, lines: [] }
  const index = await ensureIndex(argusHome, res.abs)
  return getLines(index, res.abs, from, to)
}
