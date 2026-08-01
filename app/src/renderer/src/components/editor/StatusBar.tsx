import { countBySeverity, summariseIssues } from '../../lib/diagnostics'
import { clockTime } from '../../lib/time'
import type { CursorInfo } from './surface'
import type { ViewMode } from '../../lib/editorPrefs'
import type { ValidationIssue } from '../../../../shared/assetValidation'

/** Spec §5.5. Three states, and they are mutually exclusive: a conflict outranks a draft, which
 *  outranks saved. */
export type SyncState = 'saved' | 'draft' | 'conflict'

export interface StatusBarProps {
  cursor: CursorInfo
  issues: ValidationIssue[]
  sync: SyncState
  /** ISO timestamp of the last confirmed draft write; only meaningful when `sync` is `draft`. */
  draftAt: string | null
  viewMode: ViewMode
  /**
   * Finding 1: this control is a second, independent way to run `cycleViewMode` (the header's
   * Split/Preview button is the other), and the two must not drift — spec §6.4's whole claim is
   * that a shortcut and a button cannot disagree. The caller passes `!cmdFor('cycleViewMode',
   * …)?.enabled` (AssetPane.tsx), the exact same descriptor the header button reads, so this
   * renders inert (rather than clickable-but-a-no-op) whenever the registry disables the command
   * — busy, or a proposal awaiting a decision.
   */
  viewModeDisabled?: boolean
  /**
   * Spec §5.5 lists a tier badge. There is no tier on `SkillReadPayload` or on the reference
   * read, and Increment 4 adds that plumbing because §6.2 needs it to open read-only assets
   * read-only. Optional here so Increment 4 supplies a value rather than changing this signature.
   */
  tier?: string
  onProblems: () => void
  onCycleViewMode: () => void
}

const MODE_LABEL: Record<ViewMode, string> = {
  editor: 'Editor',
  split: 'Split',
  preview: 'Preview'
}

const SYNC_TONE: Record<SyncState, string> = {
  saved: 'text-faint',
  draft: 'text-dim',
  conflict: 'text-danger'
}

export function StatusBar({
  cursor,
  issues,
  sync,
  draftAt,
  viewMode,
  viewModeDisabled = false,
  tier,
  onProblems,
  onCycleViewMode
}: StatusBarProps): React.JSX.Element {
  // Only the error count is needed — it picks the tone; the phrase is shared with the panel.
  const { errors } = countBySeverity(issues)

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-hair bg-hi px-3 py-1 font-mono text-[11px] text-faint">
      <span className="flex items-center gap-3">
        <span>
          {cursor.line}:{cursor.col}
        </span>
        {cursor.selected > 0 && <span>{cursor.selected} selected</span>}
        {issues.length > 0 && (
          <button
            type="button"
            onClick={onProblems}
            className={`hover:underline ${errors ? 'text-danger' : 'text-review'}`}
          >
            {summariseIssues(issues)}
          </button>
        )}
      </span>
      <span className="flex items-center gap-3">
        {tier && (
          <span
            data-testid="tier-badge"
            className="rounded-r1 border border-hair px-1.5 py-0.5 text-dim"
          >
            {tier}
          </span>
        )}
        <span className={SYNC_TONE[sync]}>
          {sync === 'saved' && 'Saved'}
          {sync === 'conflict' && 'Conflict'}
          {sync === 'draft' && (draftAt ? `Draft · ${clockTime(draftAt)}` : 'Draft')}
        </span>
        <button
          type="button"
          disabled={viewModeDisabled}
          onClick={onCycleViewMode}
          aria-label={`View mode: ${MODE_LABEL[viewMode]}`}
          className="hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          {MODE_LABEL[viewMode]}
        </button>
      </span>
    </div>
  )
}
