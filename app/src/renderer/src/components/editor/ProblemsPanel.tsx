import type { ValidationIssue } from '../../../../shared/assetValidation'

export interface ProblemsPanelProps {
  issues: ValidationIssue[]
  /** 1-indexed. Only called for issues that carry a line. */
  onGoToLine: (line: number) => void
}

/**
 * Spec §5.4, and the fix for defect §1.1.2 — *"Validation is unlocatable."*
 *
 * The list body only — the collapse toggle and the "N problems" tab live in `BottomDock` now,
 * shared with `ReferencesPanel`'s tab (Task 14). The counts stay visible in the status bar
 * (Task 9) either way, so nothing is hidden by collapsing — only the detail.
 */
export function ProblemsPanel({
  issues,
  onGoToLine
}: ProblemsPanelProps): React.JSX.Element | null {
  if (issues.length === 0) return null

  return (
    <ul className="max-h-40 overflow-auto pb-1">
      {issues.map((issue, n) => {
        const tone = issue.severity === 'error' ? 'text-danger' : 'text-review'
        return (
          <li key={n} className="px-3 py-0.5 text-xs">
            {issue.line === undefined ? (
              // Spec §5.4: an issue with no line goes to the panel only. Rendering it as a
              // button would promise a jump target that does not exist.
              <span className={`flex gap-2 ${tone}`}>
                <span className="w-10 shrink-0 select-none text-right font-mono text-faint">—</span>
                <span className="min-w-0">{issue.message}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onGoToLine(issue.line!)}
                className={`flex w-full gap-2 text-left hover:underline ${tone}`}
              >
                <span className="w-10 shrink-0 select-none text-right font-mono text-faint">
                  {issue.line}
                </span>
                <span className="min-w-0">{issue.message}</span>
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
