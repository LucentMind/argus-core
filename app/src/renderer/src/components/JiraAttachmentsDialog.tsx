import { useEffect, useId, useState } from 'react'
import { Btn, Chip } from './ui'
import { ModalShell } from './ModalShell'
import type { JiraAttachmentInfo } from '../../../shared/jira'
import { panelsStore } from '../lib/panelsStore'
import { sortAttachmentsByType } from '../lib/attachmentOrder'

const kb = (n: number): string => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

/**
 * Selection dialog shown after a refresh finds new attachments. Confirm
 * downloads the checked set and persists the unchecked set as deselected;
 * Cancel changes nothing (the same decision is re-offered next refresh).
 * Already-ingested attachments render as synced context rows — checked,
 * disabled, and excluded from the confirm math entirely (spec §4).
 */
export function JiraAttachmentsDialog({
  slug,
  jiraKey,
  newAttachments,
  deselectedAttachments,
  ingestedAttachments,
  onClose
}: {
  slug: string
  jiraKey: string
  newAttachments: JiraAttachmentInfo[]
  deselectedAttachments: JiraAttachmentInfo[]
  ingestedAttachments: JiraAttachmentInfo[]
  onClose: () => void
}): React.JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(newAttachments.map((a) => a.id))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Rows stay grouped by bucket (new / skipped / synced) — that grouping is the point of this
  // dialog — and sort by type within each bucket.
  const fresh = sortAttachmentsByType(newAttachments)
  const skipped = sortAttachmentsByType(deselectedAttachments)
  const synced = sortAttachmentsByType(ingestedAttachments)

  // The rows the user can actually act on. Synced rows are fixed (checked+disabled) and are
  // excluded from the confirm math entirely, so they must stay out of the toggle-all math too.
  const selectable = [...newAttachments, ...deselectedAttachments]
  const allSelected = selectable.length > 0 && selectable.every((a) => checked.has(a.id))

  // A docked panel is a native WebContentsView that paints above all DOM, so this modal must
  // register itself as an occlusion source (see panelsStore.registerModal) -- registering here
  // rather than at the call site means a future call site can't forget to occlude the panel.
  const modalId = useId()
  useEffect(() => panelsStore.registerModal(modalId), [modalId])

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    const all = [...newAttachments, ...deselectedAttachments]
    const selected = all.filter((a) => checked.has(a.id))
    const deselectedIds = all.filter((a) => !checked.has(a.id)).map((a) => a.id)
    // downloads continue in background (progress via evidence:changed); persist first
    const r = await window.argus.jira.setAttachmentSelection(slug, deselectedIds)
    if (!r.ok) {
      setBusy(false)
      setError(r.message)
      return
    }
    if (selected.length) void window.argus.jira.ingestAttachments(slug, jiraKey, selected)
    onClose()
  }

  function row(a: JiraAttachmentInfo, tag: 'new' | 'skipped' | 'synced'): React.JSX.Element {
    const synced = tag === 'synced'
    return (
      <label
        key={a.id}
        className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs hover:bg-hi"
      >
        <input
          type="checkbox"
          aria-label={a.filename}
          checked={synced || checked.has(a.id)}
          disabled={synced}
          onChange={(e) => {
            if (synced) return
            const next = new Set(checked)
            if (e.target.checked) next.add(a.id)
            else next.delete(a.id)
            setChecked(next)
          }}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-ink">{a.filename}</span>
        {tag === 'new' && <Chip tone="signal">new</Chip>}
        {tag === 'skipped' && <Chip tone="neutral">previously skipped</Chip>}
        {tag === 'synced' && <Chip tone="neutral">synced</Chip>}
        <span className="shrink-0 text-mute">{kb(a.size)}</span>
      </label>
    )
  }

  return (
    <ModalShell
      title="Ticket attachments changed"
      ariaLabel="Ticket attachments changed"
      onClose={busy ? () => {} : onClose}
      className="max-h-[85vh] w-[560px]"
    >
      {/* Three bands rather than one scrolling column: a ticket can carry dozens of
          attachments, and with everything in one `overflow-y-auto` the toggle-all row and the
          confirm buttons scrolled off with the list. Only the list scrolls now. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-3 p-4 pb-2">
          {error && (
            <div
              role="alert"
              className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
            >
              {error}
            </div>
          )}
          {/* The toggle-all is a button, not a checkbox: a checkbox here would sit in the same
              column as the per-file boxes and read as just another attachment row. */}
          {selectable.length > 0 && (
            <div className="flex items-center gap-2 border-b border-hair pb-2 text-xs">
              <span className="uppercase tracking-wide text-dim">Attachments</span>
              <Btn
                // outline, not ghost: a borderless control beside a span of text read as
                // a second label rather than as something clickable.
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() =>
                  setChecked(allSelected ? new Set() : new Set(selectable.map((a) => a.id)))
                }
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </Btn>
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-4">
          {fresh.map((a) => row(a, 'new'))}
          {skipped.map((a) => row(a, 'skipped'))}
          {synced.map((a) => row(a, 'synced'))}
        </div>
        <div className="flex items-center gap-2 p-4 pt-3">
          <Btn variant="primary" disabled={busy} onClick={() => void confirm()}>
            Download selected
          </Btn>
          <Btn variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </div>
      </div>
    </ModalShell>
  )
}
