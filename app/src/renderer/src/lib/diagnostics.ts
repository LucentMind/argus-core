import type { ValidationIssue } from '../../../shared/assetValidation'

/**
 * The subset of CodeMirror's `Text` this module needs. `EditorState.doc` satisfies it
 * structurally, and so does a hand-rolled fake — which is what keeps the mapping provable in a
 * node-environment test, with no DOM and no CodeMirror state (spec §8.1).
 */
export interface DocLines {
  readonly lines: number
  line(n: number): { from: number; to: number }
}

/** Structurally a `@codemirror/lint` `Diagnostic`, declared locally so this module imports
 *  nothing from CodeMirror at all. */
export interface PlacedDiagnostic {
  from: number
  to: number
  severity: 'error' | 'warning'
  message: string
}

export interface Partitioned {
  /** Issues that can be pointed at, as gutter markers and inline marks. */
  placed: PlacedDiagnostic[]
  /** Issues with no line. Spec §5.4: these go to the problems panel only — **never** faked onto
   *  line 1, which would mark an innocent line and send a click to the wrong place. */
  unplaced: ValidationIssue[]
}

export function partitionIssues(issues: ValidationIssue[], doc: DocLines): Partitioned {
  const placed: PlacedDiagnostic[] = []
  const unplaced: ValidationIssue[] = []
  for (const issue of issues) {
    if (issue.line === undefined) {
      unplaced.push(issue)
      continue
    }
    // Clamp rather than trust. `Text.line()` throws a RangeError on an out-of-range number
    // ("Invalid line number 4 in 3-line document"), and the numbers arriving here can outrun
    // the document: issues are computed from a React state mirror of the buffer and dispatched
    // from an effect, so a fast deletion lands in CodeMirror before the recomputed issues do.
    // A throw inside a dispatch takes the whole editor down, which is a far worse outcome than
    // a marker one line off for a single frame.
    const n = Math.min(Math.max(1, issue.line), doc.lines)
    const { from, to } = doc.line(n)
    placed.push({ from, to, severity: issue.severity, message: issue.message })
  }
  return { placed, unplaced }
}

export function countBySeverity(issues: ValidationIssue[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const i of issues) {
    if (i.severity === 'error') errors++
    else warnings++
  }
  return { errors, warnings }
}

/**
 * "1 error, 2 warnings" — the phrase both the problems panel and the status bar show.
 *
 * Shared rather than written twice: they render the same counts from the same input, and two
 * copies of this drift apart the first time one of them is reworded. Empty string for a clean
 * file, so a caller can test it for emptiness instead of re-counting.
 */
export function summariseIssues(issues: ValidationIssue[]): string {
  const { errors, warnings } = countBySeverity(issues)
  const parts: string[] = []
  if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  return parts.join(', ')
}
