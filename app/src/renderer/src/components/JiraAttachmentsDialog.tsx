import { useState } from 'react'
import { Btn, Chip, SectionLabel } from './ui'
import type { JiraAttachmentInfo } from '../../../shared/jira'

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
  newAttachments,
  deselectedAttachments,
  ingestedAttachments,
  onClose
}: {
  slug: string
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
    if (selected.length) void window.argus.jira.ingestAttachments(slug, selected)
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
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Ticket attachments changed"
        className="flex max-h-[85vh] w-[560px] flex-col gap-3 overflow-y-auto rounded-r4 border border-hair2 bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <SectionLabel>Ticket attachments changed</SectionLabel>
        {error && (
          <div
            role="alert"
            className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
          >
            {error}
          </div>
        )}
        <div className="flex flex-col gap-1">
          {newAttachments.map((a) => row(a, 'new'))}
          {deselectedAttachments.map((a) => row(a, 'skipped'))}
          {ingestedAttachments.map((a) => row(a, 'synced'))}
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="primary" disabled={busy} onClick={() => void confirm()}>
            Download selected
          </Btn>
          <Btn variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </div>
      </div>
    </div>
  )
}
