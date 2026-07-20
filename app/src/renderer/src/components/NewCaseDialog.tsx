import { useEffect, useMemo, useState } from 'react'
import { Btn, Chip } from './ui'
import { ModalShell } from './ModalShell'
import { transientFieldEscape } from '../lib/escapeLayer'
import type { NewCaseInput } from '../../../shared/types'
import type { JiraAttachmentInfo, JiraIssuePreview } from '../../../shared/jira'

const INPUT =
  'h-8 rounded-r2 border border-hair bg-overlay px-2.5 text-sm text-ink placeholder:text-mute transition-colors focus:border-hair2'

type FileStatus = 'pending' | 'downloading' | 'done' | 'error'
interface FileRow {
  att: JiraAttachmentInfo
  status: FileStatus
  error?: string
}

type Step =
  | { step: 'entry' }
  | { step: 'preview'; ticketKey: string; preview: JiraIssuePreview }
  | { step: 'ingest'; slug: string; files: FileRow[] }

const kb = (n: number): string => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

export function NewCaseDialog({
  onClose,
  onCreateBlank,
  onOpenCase
}: {
  onClose: () => void
  onCreateBlank: (input: NewCaseInput) => Promise<void>
  onOpenCase: (slug: string) => void
}): React.JSX.Element {
  const [step, setStep] = useState<Step>({ step: 'entry' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // entry — ticket path
  const [ticketKey, setTicketKey] = useState('')
  // entry — blank path (moved from the dashboard card)
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [jira, setJira] = useState('')
  // preview — editable prefills + selection
  const [caseSlug, setCaseSlug] = useState('')
  const [caseTitle, setCaseTitle] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())

  // per-file progress stream (main keeps downloading even if the dialog closes)
  const ingestSlug = step.step === 'ingest' ? step.slug : null
  useEffect(() => {
    if (ingestSlug === null) return
    return window.argus.jira.onAttachmentProgress((p) => {
      if (p.caseSlug !== ingestSlug) return
      setStep((s) =>
        s.step === 'ingest'
          ? {
              ...s,
              files: s.files.map((f) =>
                f.att.id === p.attachmentId ? { ...f, status: p.status, error: p.error } : f
              )
            }
          : s
      )
    })
  }, [ingestSlug])

  async function fetchTicket(): Promise<void> {
    const key = ticketKey.trim()
    setBusy(true)
    setError(null)
    // Clear the entry field synchronously (same render as setBusy) so its value
    // can't transiently collide with the fetched key's displayed value once the
    // preview step mounts — the two fields would otherwise briefly show the same
    // text while the async fetch is in flight. Restored below if the fetch fails,
    // so a failed lookup doesn't cost the user their typed key.
    setTicketKey('')
    const r = await window.argus.jira.preview(key)
    setBusy(false)
    if (!r.ok) {
      setTicketKey(key)
      setError(
        r.code === 'not-configured'
          ? `${r.message} (Settings → Connectors)`
          : r.code === 'not-found'
            ? `Ticket ${key} not found on Jira.`
            : r.message
      )
      return
    }
    setCaseSlug(r.value.key)
    setCaseTitle(r.value.summary)
    setChecked(new Set(r.value.attachments.map((a) => a.id)))
    setStep({ step: 'preview', ticketKey: r.value.key, preview: r.value })
  }

  async function createBlank(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreateBlank({ slug, title, jiraKey: jira || undefined })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function createFromTicket(): Promise<void> {
    if (step.step !== 'preview') return
    setBusy(true)
    setError(null)
    const r = await window.argus.jira.createCase({
      slug: caseSlug.trim(),
      title: caseTitle.trim(),
      key: step.ticketKey
    })
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    const deselectedIds = step.preview.attachments
      .filter((a) => !checked.has(a.id))
      .map((a) => a.id)
    if (deselectedIds.length)
      void window.argus.jira.setAttachmentSelection(r.value.slug, deselectedIds)
    const selected = step.preview.attachments.filter((a) => checked.has(a.id))
    setStep({
      step: 'ingest',
      slug: r.value.slug,
      files: selected.map((att) => ({ att, status: 'pending' as const }))
    })
    if (selected.length) void window.argus.jira.ingestAttachments(r.value.slug, selected)
  }

  function retry(file: FileRow): void {
    if (step.step !== 'ingest') return
    setStep({
      ...step,
      files: step.files.map((f) =>
        f.att.id === file.att.id ? { ...f, status: 'pending', error: undefined } : f
      )
    })
    void window.argus.jira.ingestAttachments(step.slug, [file.att])
  }

  const settled = useMemo(
    () =>
      step.step === 'ingest'
        ? step.files.every((f) => f.status === 'done' || f.status === 'error')
        : false,
    [step]
  )

  return (
    <ModalShell
      title="New case"
      ariaLabel="New case"
      onClose={onClose}
      className="max-h-[85vh] w-[560px]"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {error && (
          <div
            role="alert"
            className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
          >
            {error}
          </div>
        )}

        {step.step === 'entry' && (
          <>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-dim">From a Jira ticket</span>
              <div className="flex gap-2">
                <input
                  className={`${INPUT} min-w-0 flex-1 font-mono`}
                  placeholder="ticket key (e.g. PROJ-1234)"
                  value={ticketKey}
                  onChange={(e) => setTicketKey(e.target.value)}
                  onKeyDown={(e) =>
                    transientFieldEscape(e, ticketKey === '', () => setTicketKey(''))
                  }
                />
                <Btn
                  variant="primary"
                  disabled={!ticketKey.trim() || busy}
                  onClick={() => void fetchTicket()}
                >
                  {busy ? 'Fetching…' : 'Fetch ticket'}
                </Btn>
              </div>
            </div>
            <div className="my-1 h-px bg-hair" />
            <div className="flex flex-col gap-2">
              <span className="text-xs text-dim">…or a blank case</span>
              <input
                className={`${INPUT} font-mono`}
                placeholder="slug (e.g. NAVAPI-123)"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                onKeyDown={(e) => transientFieldEscape(e, slug === '', () => setSlug(''))}
              />
              <input
                className={INPUT}
                placeholder="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => transientFieldEscape(e, title === '', () => setTitle(''))}
              />
              <input
                className={`${INPUT} font-mono`}
                placeholder="jira key (optional)"
                value={jira}
                onChange={(e) => setJira(e.target.value)}
                onKeyDown={(e) => transientFieldEscape(e, jira === '', () => setJira(''))}
              />
              <Btn
                variant="outline"
                className="justify-center"
                disabled={!slug || !title || busy}
                onClick={() => void createBlank()}
              >
                Create blank case
              </Btn>
            </div>
          </>
        )}

        {step.step === 'preview' && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-mono text-defect">{step.preview.key}</span>
              <Chip tone="neutral">{step.preview.status}</Chip>
              <span className="truncate text-dim">{step.preview.summary}</span>
            </div>
            <input
              aria-label="Case slug"
              className={`${INPUT} font-mono`}
              value={caseSlug}
              onChange={(e) => setCaseSlug(e.target.value)}
              onKeyDown={(e) => transientFieldEscape(e, caseSlug === '', () => setCaseSlug(''))}
            />
            <input
              aria-label="Case title"
              className={INPUT}
              value={caseTitle}
              onChange={(e) => setCaseTitle(e.target.value)}
              onKeyDown={(e) => transientFieldEscape(e, caseTitle === '', () => setCaseTitle(''))}
            />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-dim">
                Attachments ({step.preview.attachments.length})
              </span>
              {step.preview.attachments.map((a) => (
                <label
                  key={a.id}
                  className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs hover:bg-hi"
                >
                  <input
                    type="checkbox"
                    checked={checked.has(a.id)}
                    onChange={(e) => {
                      const next = new Set(checked)
                      if (e.target.checked) next.add(a.id)
                      else next.delete(a.id)
                      setChecked(next)
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-ink">{a.filename}</span>
                  <span className="shrink-0 text-mute">{kb(a.size)}</span>
                  <span className="shrink-0 text-mute">{a.mimeType}</span>
                </label>
              ))}
              {step.preview.attachments.length === 0 && (
                <span className="text-xs text-mute">none</span>
              )}
            </div>
            <Btn
              variant="primary"
              className="justify-center"
              disabled={!caseSlug.trim() || !caseTitle.trim() || busy}
              onClick={() => void createFromTicket()}
            >
              Create case
            </Btn>
          </>
        )}

        {step.step === 'ingest' && (
          <>
            <div className="text-sm text-ink">
              Case <span className="font-mono text-defect">{step.slug}</span> created.
            </div>
            {step.files.length > 0 && (
              <div className="flex flex-col gap-1">
                {step.files.map((f) => (
                  <div key={f.att.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-ink">
                      {f.att.filename}
                    </span>
                    {f.status === 'error' ? (
                      <>
                        <Chip tone="danger">error</Chip>
                        <span className="max-w-40 truncate text-mute" title={f.error}>
                          {f.error}
                        </span>
                        <Btn variant="outline" onClick={() => retry(f)}>
                          Retry
                        </Btn>
                      </>
                    ) : f.status === 'done' ? (
                      <Chip tone="signal">done</Chip>
                    ) : (
                      <Chip tone="review">
                        {f.status === 'downloading' ? 'downloading…' : 'queued'}
                      </Chip>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Btn
                variant="primary"
                onClick={() => {
                  onOpenCase(step.slug)
                  onClose()
                }}
              >
                Start triage
              </Btn>
              {!settled && step.files.length > 0 && (
                <span className="text-xs text-mute">downloads continue in the background</span>
              )}
            </div>
          </>
        )}
      </div>
    </ModalShell>
  )
}
