import { ChevronDown, ChevronRight } from 'lucide-react'
import { countBySeverity, summariseIssues } from '../../lib/diagnostics'
import type { ValidationIssue } from '../../../../shared/assetValidation'

export interface ProblemsPanelProps {
  issues: ValidationIssue[]
  open: boolean
  onToggle: () => void
  /** 1-indexed. Only called for issues that carry a line. */
  onGoToLine: (line: number) => void
}

/**
 * Spec §5.4, and the fix for defect §1.1.2 — *"Validation is unlocatable."*
 *
 * A collapsible strip rather than a permanent one: a clean file should give the document its
 * space back, and most files are clean most of the time. The counts stay visible in the status
 * bar (Task 9) either way, so nothing is hidden by collapsing — only the detail.
 */
export function ProblemsPanel({
  issues,
  open,
  onToggle,
  onGoToLine
}: ProblemsPanelProps): React.JSX.Element | null {
  if (issues.length === 0) return null
  // Only the error count is needed here — it picks the tone. The phrase itself is shared.
  const { errors } = countBySeverity(issues)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="flex shrink-0 flex-col border-t border-hair">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-1.5 text-left text-xs text-dim hover:text-ink"
      >
        <Chevron size={13} aria-hidden="true" />
        <span className={errors ? 'text-danger' : 'text-review'}>{summariseIssues(issues)}</span>
      </button>
      {open && (
        <ul className="max-h-40 overflow-auto pb-1">
          {issues.map((issue, n) => {
            const tone = issue.severity === 'error' ? 'text-danger' : 'text-review'
            return (
              <li key={n} className="px-3 py-0.5 text-xs">
                {issue.line === undefined ? (
                  // Spec §5.4: an issue with no line goes to the panel only. Rendering it as a
                  // button would promise a jump target that does not exist.
                  <span className={`flex gap-2 ${tone}`}>
                    <span className="w-10 shrink-0 select-none text-right font-mono text-faint">
                      —
                    </span>
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
      )}
    </div>
  )
}
