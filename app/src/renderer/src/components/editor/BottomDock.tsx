import { ChevronDown, ChevronRight } from 'lucide-react'
import { ProblemsPanel } from './ProblemsPanel'
import { ReferencesPanel } from './ReferencesPanel'
import { countBySeverity, summariseIssues } from '../../lib/diagnostics'
import type { ValidationIssue } from '../../../../shared/assetValidation'
import type { ReferenceHit } from '../../../../shared/corpusSearch'

export type DockTab = 'problems' | 'references'

export interface BottomDockProps {
  issues: ValidationIssue[]
  /** `null` until a search has been run in this tab. */
  references: { query: string; hits: readonly ReferenceHit[] } | null
  searching: boolean
  /**
   * Open/collapsed and which tab, both **controlled by `AssetPane`**.
   *
   * Not local state, and the reason is a lint rule rather than taste: two things outside this
   * component need to drive it — the status bar's problem-count button (spec §5.5's
   * "click → problems") and a landing find-references search, which must select its own tab or
   * the feature fails at its last step. Deriving that here would need a `useEffect` watching
   * `references` and calling `setState`, which `react-hooks/set-state-in-effect` forbids and
   * this repo does not allow suppressing. `AssetPane` sets both fields inside the handlers that
   * already exist (`findReferences`, the status bar's `onProblems`), so no effect is involved
   * anywhere.
   */
  open: boolean
  tab: DockTab
  onOpenChange: (open: boolean) => void
  onTabChange: (tab: DockTab) => void
  /** 1-indexed. Only called for issues that carry a line. */
  onGoToLine: (line: number) => void
  onOpenHit: (hit: ReferenceHit) => void
  onDismissReferences: () => void
}

/**
 * Spec §5.4's problems strip and §6.3's find-references results, sharing one strip rather than
 * stacking two panels — §6.3 puts the results "in the problems-panel slot", and two independently
 * collapsing docks at the bottom of a split editor is how that slot stops being a slot.
 *
 * Still absent entirely when there is nothing to say: a clean file with no search gives the
 * document its space back, which is what `ProblemsPanel` did before this.
 */
export function BottomDock({
  issues,
  references,
  searching,
  open,
  tab,
  onOpenChange,
  onTabChange,
  onGoToLine,
  onOpenHit,
  onDismissReferences
}: BottomDockProps): React.JSX.Element | null {
  const hasRefs = references !== null || searching
  if (issues.length === 0 && !hasRefs) return null

  const { errors } = countBySeverity(issues)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="flex shrink-0 flex-col border-t border-hair">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          className="text-dim hover:text-ink"
        >
          <Chevron size={13} aria-hidden="true" />
        </button>
        <div role="tablist" aria-label="Editor panels" className="flex items-center gap-3">
          {issues.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-label="Problems"
              aria-selected={tab === 'problems'}
              onClick={() => {
                onTabChange('problems')
                onOpenChange(true)
              }}
              className={`${tab === 'problems' ? 'underline' : ''} ${errors ? 'text-danger' : 'text-review'}`}
            >
              {summariseIssues(issues)}
            </button>
          )}
          {hasRefs && (
            <button
              type="button"
              role="tab"
              aria-label="References"
              aria-selected={tab === 'references'}
              onClick={() => {
                onTabChange('references')
                onOpenChange(true)
              }}
              className={`${tab === 'references' ? 'underline' : ''} text-dim`}
            >
              {searching
                ? 'Searching…'
                : references!.hits.length === 0
                  ? `Nothing mentions ${references!.query}`
                  : `${references!.hits.length} references to ${references!.query}`}
            </button>
          )}
        </div>
        {references !== null && (
          <button
            type="button"
            onClick={() => {
              onDismissReferences()
              onTabChange('problems')
            }}
            className="ml-auto text-faint hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>
      {open && tab === 'problems' && <ProblemsPanel issues={issues} onGoToLine={onGoToLine} />}
      {open && tab === 'references' && references !== null && (
        <ReferencesPanel hits={references.hits} onOpenHit={onOpenHit} />
      )}
    </div>
  )
}
