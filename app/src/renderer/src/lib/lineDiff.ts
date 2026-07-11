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
  // guard: degenerate to whole-file replace when the LCS table would be huge
  if (a.length * b.length > 400_000) {
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
