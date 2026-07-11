import type { DiffLine } from './lineDiff'

export type UnifiedSegment =
  { meta: string } | { meta?: undefined; leftStart: number; rightStart: number; lines: DiffLine[] }

const DROPPED_HEADER =
  /^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |copy |Binary files|\\ No newline)/

/**
 * Parse `git diff` unified text into per-file meta rows and hunks that carry
 * their real start line numbers, ready for pairRows(). Content outside any
 * hunk is ignored, so plain non-diff text parses to [].
 */
export function parseUnifiedDiff(text: string): UnifiedSegment[] {
  const segs: UnifiedSegment[] = []
  let hunk: { leftStart: number; rightStart: number; lines: DiffLine[] } | null = null
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (m) {
      hunk = { leftStart: Number(m[1]), rightStart: Number(m[2]), lines: [] }
      segs.push(hunk)
      continue
    }
    if (raw.startsWith('diff --git ')) {
      segs.push({ meta: raw.slice('diff --git '.length) })
      hunk = null
      continue
    }
    if (DROPPED_HEADER.test(raw)) continue
    if (!hunk) continue
    if (raw.startsWith('+')) hunk.lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) hunk.lines.push({ kind: 'del', text: raw.slice(1) })
    else hunk.lines.push({ kind: 'same', text: raw.slice(1) })
  }
  return segs
}
