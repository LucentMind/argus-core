export type TextDocSource =
  | { kind: 'evidence'; evidenceId: number }
  | { kind: 'repo'; caseSlug: string; repoName: string; relPath: string }

export function textDocKey(source: TextDocSource): string {
  return source.kind === 'evidence'
    ? `e:${source.evidenceId}`
    : `r:${source.caseSlug}:${source.repoName}:${source.relPath}`
}

export interface TextDocOpenOk {
  ok: true
  title: string
  lang: string | null
  ref: string | null
  totalLines: number
  /** present ⇢ file ≤ MAX_READ_BYTES; render legacy whole-content path */
  whole?: string
  caseSlug?: string
  relPath?: string
  evidenceId?: number
}

export type TextDocOpenResult =
  TextDocOpenOk | { ok: false; reason: 'repo-not-linked' | 'not-found' }

export interface TextDocLines {
  from: number
  lines: string[]
}

export interface TextDocSearchEvent {
  searchId: string
  hits: number[]
  scannedTo: number
  done: boolean
  capped: boolean
}
