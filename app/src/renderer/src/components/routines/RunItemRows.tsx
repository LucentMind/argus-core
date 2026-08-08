import { useState } from 'react'
import { Btn, Chip, MenuButton } from '../ui'
import { CASE_RESOLUTIONS } from '../../../../shared/types'
import type { RoutineRunItemSummary, RoutineRunItemStatus } from '../../../../shared/routines'

/**
 * One row per item inside a run, in the Home inbox.
 *
 * A run with no items renders nothing — that is every routine shipped in increments 1-3, so an
 * empty `items` array must reproduce the pre-Task-13 shape exactly, not add a heading or a rule
 * with nothing under it.
 *
 * `itemKey` alone is not a safe accessible name: the inbox's ordinary shape is a nightly routine
 * revisiting the SAME ticket across nights, so two items with the same `itemKey` from different
 * runs are the ordinary case, not an edge case — increment 3 hit this exact collision with
 * routine names. Every actionable name here is therefore `` `${verb} · ${itemKey} · run ${runId}`
 * ``, keyed off `id` (globally unique) for React's own key, never off `itemKey`.
 */

const ITEM_TONE: Record<RoutineRunItemStatus, 'signal' | 'danger' | 'defect' | 'review'> = {
  processed: 'signal',
  failed: 'danger',
  skipped: 'defect',
  running: 'review'
}

function ItemRow({
  item,
  onOpen,
  onMutationError
}: {
  item: RoutineRunItemSummary
  onOpen: (slug: string) => void
  onMutationError: (message: string) => void
}): React.JSX.Element {
  const label = `${item.itemKey} · run ${item.runId}`
  const caseSlug = item.caseSlug
  const canAct = item.status === 'processed' && caseSlug !== null

  async function accept(): Promise<void> {
    try {
      await window.argus.routines.acceptItem(item.id)
      onMutationError('')
    } catch (e) {
      onMutationError((e as Error).message)
    }
  }

  async function dismiss(resolution: (typeof CASE_RESOLUTIONS)[number]): Promise<void> {
    try {
      await window.argus.routines.dismissItem(item.id, resolution)
      onMutationError('')
    } catch (e) {
      onMutationError((e as Error).message)
    }
  }

  return (
    <div className="flex items-start gap-3 py-2 text-xs">
      <Chip tone={ITEM_TONE[item.status]}>
        <span>{item.status}</span>
      </Chip>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ink">{item.itemKey}</span>
        {item.suggestion && (
          <div className="flex flex-wrap items-center gap-1.5 text-dim">
            {item.suggestion.title && <span>{item.suggestion.title}</span>}
            {item.suggestion.tags?.map((tag) => (
              <Chip key={tag} tone="neutral">
                {tag}
              </Chip>
            ))}
          </div>
        )}
        {/* The status chip already renders the literal word "failed"/"skipped" (via
            `ITEM_TONE`/`item.status` above) — repeating that word here would give a single
            status two separate DOM nodes matching the same text, so the failed line gives the
            *reason* and the skipped line explains *why*, in words that don't repeat the chip's
            own label. */}
        {item.status === 'failed' && (
          <p className="text-danger">{item.error ?? 'no error recorded'}</p>
        )}
        {item.status === 'skipped' && <p className="text-faint">already had an open case</p>}
      </div>
      {canAct && (
        <div className="flex shrink-0 items-center gap-2">
          <Btn aria-label={`Open case · ${label}`} onClick={() => onOpen(caseSlug)}>
            Open case
          </Btn>
          <Btn aria-label={`Accept · ${label}`} onClick={() => void accept()}>
            Accept
          </Btn>
          <MenuButton
            label="Dismiss"
            aria-label={`Dismiss · ${label}`}
            items={CASE_RESOLUTIONS.map((r) => ({
              label: r,
              onSelect: () => void dismiss(r)
            }))}
          />
        </div>
      )}
    </div>
  )
}

export function RunItemRows({
  items,
  onOpen
}: {
  items: RoutineRunItemSummary[]
  onOpen: (slug: string) => void
}): React.JSX.Element | null {
  /**
   * Same idiom as `RoutineInbox`'s `mutationError`/`errorPayload` pair, and for the same reason:
   * this component's own "nothing to show" case is `items.length === 0`, which returns `null`
   * below WITHOUT unmounting — the parent (`RoutineInbox`) keeps this fiber mounted at the same
   * position across a payload refresh, only handing it a new (possibly empty) `items` array. An
   * effect keyed on `items` would run AFTER the empty render already committed, so a stale error
   * from a previous, now-emptied set of items would flash back onto whatever this row shows next.
   * Resetting during render — React's documented "adjust state when a prop changes" pattern —
   * retires the error the instant a genuinely new `items` array arrives (a fresh `routines:changed`
   * broadcast), and never on the render the error itself just produced (accept/dismiss failing
   * mutates no payload, so `items` keeps its same identity across that render).
   */
  const [errorItems, setErrorItems] = useState(items)
  const [mutationError, setMutationError] = useState<string | null>(null)
  if (items !== errorItems) {
    setErrorItems(items)
    setMutationError(null)
  }

  if (items.length === 0) return null

  return (
    <div className="flex flex-col gap-1 pl-4">
      {mutationError && (
        <p
          role="alert"
          className="rounded-r2 border border-danger/40 bg-danger/10 p-2 text-xs text-danger"
        >
          {mutationError}
        </p>
      )}
      <div className="flex flex-col divide-y divide-hair2">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            onOpen={onOpen}
            onMutationError={(msg) => setMutationError(msg || null)}
          />
        ))}
      </div>
    </div>
  )
}
