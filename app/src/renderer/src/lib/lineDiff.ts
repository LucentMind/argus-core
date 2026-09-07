export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** Minimal LCS line diff for proposal previews (small inputs; O(n*m) with a size guard). */
export function diffLines(before: string, after: string): DiffLine[] {
  // Line-ending agnostic: bundled skills are CRLF on Windows, agent content is
  // typically LF — splitting on '\n' alone left a trailing '\r' on every "before"
  // line, so every line compared unequal and the diff degenerated to a full
  // remove+re-add instead of a real diff.
  const a = before.split(/\r\n|\r|\n/)
  const b = after.split(/\r\n|\r|\n/)
  // guard: degenerate to whole-file replace when the LCS table would be huge. The bound is
  // generous on purpose — a ~670-line reference editing itself is 662*672 ≈ 445k cells, and
  // the old 400k limit wrongly collapsed exactly those real skill/reference edits to a full
  // remove+re-add. 4M cells (~2000 lines a side, a few MB / <100ms) covers real docs while
  // still bailing on pathological megabyte inputs.
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text }))
    ]
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

export interface DiffCell {
  no: number
  text: string
  kind: 'same' | 'add' | 'del'
}

/** One aligned split-view row; null on a side = filler opposite an unpaired add/del. */
export interface DiffRow {
  left: DiffCell | null
  right: DiffCell | null
}

/**
 * Pair a linear diff into side-by-side rows: same lines span both columns,
 * consecutive del/add runs pair index-wise (GitHub split view). Start offsets
 * let unified-diff hunks carry their real file line numbers.
 */
export function pairRows(lines: DiffLine[], leftStart = 1, rightStart = 1): DiffRow[] {
  const rows: DiffRow[] = []
  let leftNo = leftStart
  let rightNo = rightStart
  let dels: string[] = []
  let adds: string[] = []
  const flush = (): void => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({
        left: k < dels.length ? { no: leftNo++, text: dels[k], kind: 'del' } : null,
        right: k < adds.length ? { no: rightNo++, text: adds[k], kind: 'add' } : null
      })
    }
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (l.kind === 'same') {
      flush()
      rows.push({
        left: { no: leftNo++, text: l.text, kind: 'same' },
        right: { no: rightNo++, text: l.text, kind: 'same' }
      })
    } else if (l.kind === 'del') dels.push(l.text)
    else adds.push(l.text)
  }
  flush()
  return rows
}

/** Default number of unchanged lines kept on each side of a change. Git's own default. */
export const DIFF_CONTEXT = 3

/** A stretch of the diff that is rendered, with the real file line numbers it starts at. */
export interface DiffHunk {
  kind: 'hunk'
  lines: DiffLine[]
  leftStart: number
  rightStart: number
}

/** A collapsed run of unchanged lines. `lines` is carried so a viewer can expand it in place
 *  without re-diffing, and the starts let the expansion keep its real numbering. */
export interface DiffGap {
  kind: 'gap'
  count: number
  lines: DiffLine[]
  leftStart: number
  rightStart: number
}

export type DiffSegment = DiffHunk | DiffGap

/**
 * Split a linear diff into rendered hunks and collapsed gaps, so a one-line edit to a 600-line
 * reference shows a one-line edit instead of 600 lines with a `+` somewhere in the middle.
 *
 * A line is kept when it is a change or sits within `context` lines of one; every other run of
 * unchanged lines collapses to a gap. A diff with no changes at all is returned as a single
 * hunk rather than one giant gap: a viewer opened on an unmodified file should show the file,
 * not an invitation to click.
 */
export function hunks(lines: DiffLine[], context = DIFF_CONTEXT): DiffSegment[] {
  if (lines.length === 0) return []
  if (!lines.some((l) => l.kind !== 'same'))
    return [{ kind: 'hunk', lines, leftStart: 1, rightStart: 1 }]

  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'same') continue
    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, i + context)
    for (let j = from; j <= to; j++) keep[j] = true
  }

  const out: DiffSegment[] = []
  let leftNo = 1
  let rightNo = 1
  let i = 0
  while (i < lines.length) {
    const wanted = keep[i]
    const start = i
    const leftStart = leftNo
    const rightStart = rightNo
    while (i < lines.length && keep[i] === wanted) {
      // A del consumes a line on the left only, an add on the right only, a same both.
      if (lines[i].kind !== 'add') leftNo++
      if (lines[i].kind !== 'del') rightNo++
      i++
    }
    const run = lines.slice(start, i)
    out.push(
      wanted
        ? { kind: 'hunk', lines: run, leftStart, rightStart }
        : { kind: 'gap', count: run.length, lines: run, leftStart, rightStart }
    )
  }
  return out
}
