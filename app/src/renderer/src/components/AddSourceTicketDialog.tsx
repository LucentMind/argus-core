import { useEffect, useState } from 'react'
import { Btn } from './ui'
import { ModalShell } from './ModalShell'
import { parseJiraKeyInput } from '../lib/jiraKeyInput'
import type { CloneLink } from '../../../shared/jira'

const INPUT =
  'h-8 rounded-r2 border border-hair bg-overlay px-2.5 text-sm text-ink placeholder:text-mute transition-colors focus:border-hair2'

/**
 * Link another Jira ticket as an evidence source for this case. Discovered clone links of the
 * case's own ticket are offered as one-click options; anything else is typed in. Adding runs
 * `jira.addSource`, which links the ticket AND ingests its text and comments — attachments are
 * offered by the next refresh, not here, so this dialog never downloads anything.
 */
export function AddSourceTicketDialog({
  slug,
  jiraKey,
  onClose,
  onAdded
}: {
  slug: string
  /** The case's OWN ticket, whose clone links are the discovery source. Required, not nullable:
   *  a case with no ticket has nothing to discover from, and `JiraSection` renders none of this
   *  in that state. */
  jiraKey: string
  onClose: () => void
  onAdded: () => void
}): React.JSX.Element {
  const [links, setLinks] = useState<CloneLink[]>([])
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void window.argus.jira.preview(jiraKey).then((r) => {
      if (!live) return
      if (r.ok) setLinks(r.value.cloneLinks)
      else setError(r.message)
    })
    return () => {
      live = false
    }
  }, [jiraKey])

  async function add(key: string): Promise<void> {
    if (busy || !key) return
    setBusy(true)
    setError(null)
    const r = await window.argus.jira.addSource(slug, key)
    setBusy(false)
    if (!r.ok) {
      // Stay open: the two likely failures (a typo'd key, the case's own key) are both things
      // the user fixes in this field, and closing would make them reopen and retype.
      setError(r.message)
      return
    }
    onAdded()
    onClose()
  }

  return (
    <ModalShell
      title="Add source ticket"
      ariaLabel="Add source ticket"
      onClose={busy ? () => {} : onClose}
      className="w-[460px]"
    >
      <div className="flex flex-col gap-3 p-4">
        {error && (
          <div
            role="alert"
            className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
          >
            {error}
          </div>
        )}
        {links.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-dim">Cloned tickets</span>
            {links.map((l) => (
              <Btn
                key={l.key}
                variant="outline"
                className="justify-start"
                disabled={busy}
                onClick={() => void add(l.key)}
              >
                <span className="font-mono text-defect">{l.key}</span>
                <span className="ml-2 min-w-0 truncate text-dim">{l.summary}</span>
              </Btn>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-xs text-dim">…or another ticket</span>
          <div className="flex gap-2">
            <input
              className={`${INPUT} min-w-0 flex-1 font-mono`}
              placeholder="ticket key or link"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <Btn
              variant="primary"
              disabled={!typed.trim() || busy}
              onClick={() => void add(parseJiraKeyInput(typed))}
            >
              Add
            </Btn>
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
