/** Contract for the evidence snippet preview shown by CitationCard.
 *  Shared so renderer, preload, and main agree on the shape.
 *  NOTE: this module must stay import-free (shared must never import main). */

export const SNIPPET_BEFORE = 4
export const SNIPPET_AFTER = 6
export const MAX_SNIPPET_LINES = 40

export type EvidenceKind = 'code' | 'text'

export interface SnippetOk {
  ok: true
  evidenceId: number
  relPath: string
  /** 1-based line number of lines[0]. */
  startLine: number
  lines: string[]
  /** highlight.js language id, or null for plain text (logs, unknown). */
  lang: string | null
  /** True when the window reached the end of the file. */
  eof: boolean
  /** True when the range window was capped at MAX_SNIPPET_LINES. */
  truncated?: boolean
}

export type SnippetResult = SnippetOk | { ok: false; reason: 'not-found' }

/** Snippet read from a linked workspace repo (worktree if present, else the
 *  primary checkout). ref = live current ref of that tree, for drift honesty. */
export interface RepoSnippetOk {
  ok: true
  repoName: string
  relPath: string
  startLine: number
  lines: string[]
  lang: string | null
  eof: boolean
  truncated: boolean
  ref: string | null
}

export type RepoSnippetResult =
  RepoSnippetOk | { ok: false; reason: 'repo-not-linked' | 'not-found' }

/** Viewer-window read from a linked workspace repo (TextViewer repo mode). */
export interface RepoTextOk {
  ok: true
  repoName: string
  relPath: string
  content: string
  startLine: number
  truncated: boolean
  ref: string | null
  lang: string | null
}

export type RepoTextResult = RepoTextOk | { ok: false; reason: 'repo-not-linked' | 'not-found' }

/** Extension → highlight.js language id. Anything absent renders plain. */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  ps1: 'powershell',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  html: 'xml',
  css: 'css'
}

/** Classify an evidence relPath for display: code (syntax-highlightable) vs plain text. */
export function langForPath(relPath: string): { lang: string | null; kind: EvidenceKind } {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return { lang: null, kind: 'text' }
  const lang = EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? null
  return lang ? { lang, kind: 'code' } : { lang: null, kind: 'text' }
}
