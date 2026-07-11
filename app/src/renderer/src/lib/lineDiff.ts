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
