import { useEffect, useId, useState } from 'react'
import { Btn, Chip } from './ui'
import { ModalShell } from './ModalShell'
import type { JiraAttachmentInfo } from '../../../shared/jira'
import { panelsStore } from '../lib/panelsStore'
import { sortAttachmentsByType } from '../lib/attachmentOrder'

const kb = (n: number): string => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

/** One ticket's worth of the dialog: the case's own ticket, or one of its source tickets. */
export interface TicketGroup {
  jiraKey: string
  /** Which store the declined set belongs in: 'primary' → cases.jira_deselected (via
   *  setAttachmentSelection), 'source' → case_jira_links.deselected_ids (via
   *  setSourceAttachmentSelection). Carried explicitly rather than inferred from position,
   *  so a caller that builds the array in a different order cannot silently write a source's
   *  decision over the case's own. */
  role: 'primary' | 'source'
  newAttachments: JiraAttachmentInfo[]
  deselectedAttachments: JiraAttachmentInfo[]
  ingestedAttachments: JiraAttachmentInfo[]
}

/**
 * Selection dialog shown after a refresh finds new attachments. Confirm
 * downloads the checked set and persists the unchecked set as deselected;
 * Cancel changes nothing (the same decision is re-offered next refresh).
 * Already-ingested attachments render as synced context rows — checked,
 * disabled, and excluded from the confirm math entirely (spec §4).
 *
 * A refresh can turn up findings on the case's own ticket AND on any of its source tickets, so
 * the dialog takes N groups rather than one ticket's three lists. Each group keeps the same
 * three bands under its own header, and confirm runs per group: the group's key is what
 * attributes the downloaded files, so a source's files are never ingested under the case's key.
 * A case with no sources passes exactly one group and renders exactly as this dialog did before
 * groups existed — a lone group gets no ticket header, because with one ticket there is nothing
 * to disambiguate and the header would be new chrome on an unchanged flow.
 */
export function JiraAttachmentsDialog({
  slug,
  groups,
  onClose
}: {
  slug: string
  groups: TicketGroup[]
  onClose: () => void
}): React.JSX.Element {
  // Checked ids are namespaced by ticket: two tickets can carry the same attachment id only
  // by coincidence, but a flat set would also make "select all" ambiguous across groups.
  const key = (g: TicketGroup, a: JiraAttachmentInfo): string => `${g.jiraKey}:${a.id}`
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(groups.flatMap((g) => g.newAttachments.map((a) => `${g.jiraKey}:${a.id}`)))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The rows the user can actually act on. Synced rows are fixed (checked+disabled) and are
  // excluded from the confirm math entirely, so they must stay out of the toggle-all math too.
  const selectable = groups.flatMap((g) =>
    [...g.newAttachments, ...g.deselectedAttachments].map((a) => key(g, a))
  )
  const allSelected = selectable.length > 0 && selectable.every((k) => checked.has(k))

  // A docked panel is a native WebContentsView that paints above all DOM, so this modal must
  // register itself as an occlusion source (see panelsStore.registerModal) -- registering here
  // rather than at the call site means a future call site can't forget to occlude the panel.
  const modalId = useId()
  useEffect(() => panelsStore.registerModal(modalId), [modalId])

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    for (const g of groups) {
      const all = [...g.newAttachments, ...g.deselectedAttachments]
      const picked = all.filter((a) => checked.has(key(g, a)))
      const declinedIds = all.filter((a) => !checked.has(key(g, a))).map((a) => a.id)
      // Persist the decision BEFORE ingesting, same order as the single-ticket path: a
      // failed write must not leave files ingested against a selection nobody recorded.
      const r =
        g.role === 'primary'
          ? await window.argus.jira.setAttachmentSelection(slug, declinedIds)
          : await window.argus.jira.setSourceAttachmentSelection(slug, g.jiraKey, declinedIds)
      if (!r.ok) {
        setBusy(false)
        setError(r.message)
        return
      }
      // The per-group key is what attributes these files. Never pass the case's own key here.
      if (picked.length) void window.argus.jira.ingestAttachments(slug, g.jiraKey, picked)
    }
    onClose()
  }

  function row(
    g: TicketGroup,
    a: JiraAttachmentInfo,
    tag: 'new' | 'skipped' | 'synced'
  ): React.JSX.Element {
    const synced = tag === 'synced'
    const k = key(g, a)
    return (
      <label
        key={k}
        className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs hover:bg-hi"
      >
        <input
          type="checkbox"
          aria-label={a.filename}
          checked={synced || checked.has(k)}
          disabled={synced}
          onChange={(e) => {
            if (synced) return
            const next = new Set(checked)
            if (e.target.checked) next.add(k)
            else next.delete(k)
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
                onClick={() => setChecked(allSelected ? new Set() : new Set(selectable))}
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </Btn>
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4">
          {groups.map((g) => (
            <div key={g.jiraKey} className="flex flex-col gap-1">
              {/* Only when there is something to disambiguate: for a case with no sources the
                  dialog must look exactly as it did before groups existed. */}
              {groups.length > 1 && (
                <div className="flex items-center gap-2 border-b border-hair pb-1 text-xs">
                  <span className="font-mono text-defect">{g.jiraKey}</span>
                  <span className="text-mute">
                    {g.newAttachments.length} new
                    {g.deselectedAttachments.length > 0
                      ? `, ${g.deselectedAttachments.length} previously skipped`
                      : ''}
                  </span>
                </div>
              )}
              {sortAttachmentsByType(g.newAttachments).map((a) => row(g, a, 'new'))}
              {sortAttachmentsByType(g.deselectedAttachments).map((a) => row(g, a, 'skipped'))}
              {sortAttachmentsByType(g.ingestedAttachments).map((a) => row(g, a, 'synced'))}
            </div>
          ))}
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
