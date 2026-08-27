import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Btn, Chip } from './ui'
import { ModalShell } from './ModalShell'
import { transientFieldEscape } from '../lib/escapeLayer'
import { parseJiraKeyInput } from '../lib/jiraKeyInput'
import { parseTicketRef, splitGithubRef } from '../../../shared/ticketRef'
import { sortAttachmentsByType } from '../lib/attachmentOrder'
import type { NewCaseInput } from '../../../shared/types'
import type { JiraAttachmentInfo } from '../../../shared/jira'
import type { TicketPreview } from '../../../shared/tickets'

const INPUT =
  'h-8 rounded-r2 border border-hair bg-overlay px-2.5 text-sm text-ink placeholder:text-mute transition-colors focus:border-hair2'

type FileStatus = 'pending' | 'downloading' | 'done' | 'error'
interface FileRow {
  att: JiraAttachmentInfo
  status: FileStatus
  error?: string
  /** Set when this file's bytes were already present as evidence from another ticket in
   *  this case — a dedup hit, not a fresh copy. Names the ticket it was already ingested
   *  from, so a user who ticked the same file on both the clone and its source understands
   *  why they got one copy instead of two. */
  dedupedFrom?: string
}

type Step =
  | { step: 'entry' }
  | { step: 'preview'; ticketKey: string; preview: TicketPreview }
  | { step: 'ingest'; slug: string; jiraKey: string; files: FileRow[] }

/** Per clone-source state, keyed by ticket key. Absent = never expanded, and a source that
 *  was never expanded is never imported: discovery proposes, the user disposes. */
interface SourceState {
  loading: boolean
  error?: string
  /** Whether the row's body is showing. Collapsing is purely visual — it keeps `checked` and
   *  `included` intact, because hiding a choice must never silently withdraw it. The collapsed
   *  header therefore has to say what is still selected underneath. */
  expanded: boolean
  attachments: JiraAttachmentInfo[]
  /** Ticked attachment ids. Starts EMPTY — unlike the primary ticket, nothing is preselected. */
  checked: Set<string>
  /** Explicit "import this ticket's text & comments" consent, independent of `checked`.
   *  Starts false — expanding a row (to look) must not imply this (to choose). Ticking any
   *  attachment sets this true as a side effect (a file implies wanting the ticket), but this
   *  flag is what actually decides whether the source is sent, so a zero-attachment source
   *  (nothing tickable) can still be included. */
  included: boolean
}

const kb = (n: number): string => (n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

/**
 * Case ID prefill from a fetched preview. A Jira key (`PROJ-123`) already satisfies
 * `SLUG_RE` (caseService.ts) and is used unchanged. A GitHub ref (`owner/repo#123`) is not
 * a valid slug at all — `/` and `#` are both rejected — so it must never be used directly
 * (see Finding C2: that is exactly what let the Create button spend a real `gh issue view`
 * call before throwing "Invalid case slug"). `{repo}-{number}` is what the spec asked for,
 * and it satisfies SLUG_RE for any real GitHub repo name: repo/owner charset is limited to
 * `[A-Za-z0-9._-]`, the same set SLUG_RE allows after its required leading alnum, and GitHub
 * itself never issues a repo name starting with a non-alnum character.
 */
function prefillSlug(preview: TicketPreview): string {
  if (preview.provider !== 'github') return preview.key
  const { repo, number } = splitGithubRef(preview.key)
  return `${repo}-${number}`
}

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
  const [sources, setSources] = useState<Record<string, SourceState>>({})

  async function expandSource(key: string): Promise<void> {
    // Already fetched — the click is a collapse/expand, which must not refetch and must not
    // touch the selection. A prior failure does NOT trip this guard, so a click retries.
    const cur = sources[key]
    if (cur && !cur.error) {
      if (cur.loading) return
      setSources((s) => ({ ...s, [key]: { ...s[key], expanded: !s[key].expanded } }))
      return
    }
    setSources((s) => ({
      ...s,
      [key]: { loading: true, expanded: true, attachments: [], checked: new Set(), included: false }
    }))
    const r = await window.argus.jira.preview(key)
    setSources((s) => ({
      ...s,
      [key]: r.ok
        ? {
            loading: false,
            expanded: true,
            attachments: r.value.attachments,
            checked: new Set(),
            included: false
          }
        : {
            loading: false,
            error: r.message,
            expanded: true,
            attachments: [],
            checked: new Set(),
            included: false
          }
    }))
  }

  /** Tick or untick every attachment on one source at once. Selecting implies including the
   *  ticket (same rule as ticking a single file); clearing does NOT withdraw that consent,
   *  because the include control is what owns that decision. */
  function toggleSourceAll(key: string, on: boolean): void {
    setSources((s) => {
      const cur = s[key]
      if (!cur) return s
      return {
        ...s,
        [key]: {
          ...cur,
          checked: on ? new Set(cur.attachments.map((a) => a.id)) : new Set(),
          included: on ? true : cur.included
        }
      }
    })
  }

  function toggleSourceAttachment(key: string, id: string, on: boolean): void {
    setSources((s) => {
      const cur = s[key]
      if (!cur) return s
      const next = new Set(cur.checked)
      if (on) next.add(id)
      else next.delete(id)
      // Ticking a file implies wanting the ticket, but unticking one does not withdraw
      // consent — that's what the include control is for.
      return { ...s, [key]: { ...cur, checked: next, included: on ? true : cur.included } }
    })
  }

  function toggleSourceIncluded(key: string, on: boolean): void {
    setSources((s) => {
      const cur = s[key]
      if (!cur) return s
      return { ...s, [key]: { ...cur, included: on } }
    })
  }

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
                f.att.id === p.attachmentId
                  ? { ...f, status: p.status, error: p.error, dedupedFrom: p.dedupedFrom }
                  : f
              )
            }
          : s
      )
    })
  }, [ingestSlug])

  async function fetchTicket(): Promise<void> {
    // Parsed client-side, before any IPC call: a pull request (or other rejected input) must
    // never reach `preview` — there is nothing useful to fetch, and the error is purely about
    // the text the user typed, not anything the provider could answer.
    const parsed = parseTicketRef(ticketKey)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    const key = parsed.value.ref
    setBusy(true)
    setError(null)
    // Clear the entry field synchronously (same render as setBusy) so its value
    // can't transiently collide with the fetched key's displayed value once the
    // preview step mounts — the two fields would otherwise briefly show the same
    // text while the async fetch is in flight. Restored below if the fetch fails,
    // so a failed lookup doesn't cost the user their typed key — restored as the
    // parsed key, not the raw paste, matching the error text below.
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
    setCaseSlug(prefillSlug(r.value))
    setCaseTitle(r.value.summary)
    setChecked(new Set(r.value.attachments.map((a) => a.id)))
    setStep({ step: 'preview', ticketKey: r.value.key, preview: r.value })
  }

  async function createBlank(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreateBlank({
        slug,
        title,
        jiraKey: jira.trim() ? parseJiraKeyInput(jira) : undefined
      })
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
    // A source is imported when the user explicitly included it, or ticked any of its
    // attachments (which implies inclusion — see toggleSourceAttachment). An
    // expanded-but-otherwise-untouched source is still a "no": looking isn't choosing.
    const chosenSources = Object.entries(sources)
      .filter(([, s]) => s.included || s.checked.size > 0)
      .map(([key]) => key)

    const r = await window.argus.jira.createCase({
      slug: caseSlug.trim(),
      title: caseTitle.trim(),
      key: step.ticketKey,
      sources: chosenSources
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
    const sourceFiles = chosenSources.flatMap((key) =>
      sources[key].attachments.filter((a) => sources[key].checked.has(a.id))
    )
    setStep({
      step: 'ingest',
      slug: r.value.slug,
      jiraKey: step.ticketKey,
      files: [...selected, ...sourceFiles].map((att) => ({ att, status: 'pending' as const }))
    })
    // Sequenced, not concurrent: dedup is check-then-insert (main hashes the download,
    // looks for an existing evidence row, and only copies on a miss), so two ingest
    // batches racing could both miss the check and both insert — the same interleaving
    // that also risks a UNIQUE(case_id, rel_path) violation via the non-atomic
    // collisionFreeName -> copyAndHash sequence. Fired without `await`ing the IIFE itself
    // so the dialog stays responsive and downloads keep going if the user navigates away;
    // only the calls INSIDE the chain are sequenced against each other.
    void (async () => {
      if (selected.length)
        await window.argus.jira.ingestAttachments(r.value.slug, step.ticketKey, selected)
      for (const key of chosenSources) {
        const s = sources[key]
        const picked = s.attachments.filter((a) => s.checked.has(a.id))
        if (picked.length) await window.argus.jira.ingestAttachments(r.value.slug, key, picked)
      }
    })()
  }

  function retry(file: FileRow): void {
    if (step.step !== 'ingest') return
    setStep({
      ...step,
      files: step.files.map((f) =>
        f.att.id === file.att.id ? { ...f, status: 'pending', error: undefined } : f
      )
    })
    void window.argus.jira.ingestAttachments(step.slug, step.jiraKey, [file.att])
  }

  // Toggle-all math for the preview step's attachment list. Every attachment on a fresh
  // preview is selectable (nothing is ingested yet), so this is simply the whole list.
  const previewAttachments = useMemo(
    () => (step.step === 'preview' ? sortAttachmentsByType(step.preview.attachments) : []),
    [step]
  )
  const allSelected =
    previewAttachments.length > 0 && previewAttachments.every((a) => checked.has(a.id))

  const settled = useMemo(
    () =>
      step.step === 'ingest'
        ? step.files.every((f) => f.status === 'done' || f.status === 'error')
        : false,
    [step]
  )

  return (
    <ModalShell
      // Once a ticket is fetched, its identity IS the dialog's subject, so it belongs in the
      // chrome rather than in a row of its own — a standalone identity line cost a whole band
      // of vertical space to say what the header could carry for free.
      title={
        step.step === 'preview' ? (
          <>
            <span>New case</span>
            <span className="text-hair2">·</span>
            <span className="text-defect">{step.preview.key}</span>
            <Chip tone="neutral">{step.preview.status}</Chip>
          </>
        ) : (
          'New case'
        )
      }
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
                  placeholder="ticket key or link (e.g. PROJ-1234)"
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
                placeholder="jira key or link (optional)"
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
            {/* No identity row here: the key and status live in the dialog header, and the
                summary is the prefill of the Title field below. Both used to be repeated here,
                which is how the same sentence ended up on screen three times. This one line is
                the exception — which tracker resolved the ref is not visible anywhere else in
                the dialog, and a case silently created against the wrong provider is a much
                worse surprise than a redundant label. */}
            <div className="text-xs text-mute">
              {step.preview.provider === 'github' ? 'GitHub issue' : 'Jira ticket'}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-dim" htmlFor="new-case-slug">
                Case ID
              </label>
              <input
                id="new-case-slug"
                aria-label="Case slug"
                className={`${INPUT} font-mono`}
                value={caseSlug}
                onChange={(e) => setCaseSlug(e.target.value)}
                onKeyDown={(e) => transientFieldEscape(e, caseSlug === '', () => setCaseSlug(''))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-dim" htmlFor="new-case-title">
                Title
              </label>
              <input
                id="new-case-title"
                aria-label="Case title"
                className={INPUT}
                value={caseTitle}
                onChange={(e) => setCaseTitle(e.target.value)}
                onKeyDown={(e) => transientFieldEscape(e, caseTitle === '', () => setCaseTitle(''))}
              />
            </div>
            <div className="flex min-h-0 flex-col gap-1">
              {/* The toggle-all is a button, not a checkbox: a checkbox here would sit in the
                  same column as the per-file boxes and read as just another file row. */}
              <div className="flex items-center gap-2 border-b border-hair pb-1 text-xs">
                <span className="uppercase tracking-wide text-dim">
                  Attachments ({previewAttachments.length})
                </span>
                {previewAttachments.length > 0 && (
                  <Btn
                    // outline, not ghost: a borderless control beside a span of text read as
                    // a second label rather than as something clickable.
                    variant="outline"
                    className="ml-auto"
                    // Named by ticket: once a clone row is expanded there are two of these on
                    // screen, and "Select all" alone does not say whose files it takes.
                    aria-label={`${allSelected ? 'Deselect' : 'Select'} all ${step.preview.key} attachments`}
                    onClick={() =>
                      setChecked(
                        allSelected ? new Set() : new Set(previewAttachments.map((a) => a.id))
                      )
                    }
                  >
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </Btn>
                )}
              </div>
              {/* A ticket can carry dozens of attachments; without a cap here the list pushed
                  "Create case" off the bottom of the dialog and the user had to scroll the whole
                  modal to reach it. The list gets its own scroll instead. */}
              <div className="flex max-h-64 min-h-0 flex-col gap-1 overflow-y-auto">
                {previewAttachments.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs hover:bg-hi"
                  >
                    <input
                      type="checkbox"
                      className="shrink-0"
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
                {previewAttachments.length === 0 && <span className="text-xs text-mute">none</span>}
              </div>
            </div>
            {step.preview.cloneLinks.length > 0 && (
              <div className="flex flex-col gap-1">
                {step.preview.cloneLinks.map((link) => {
                  const s = sources[link.key]
                  const open = !!s?.expanded
                  const allChecked =
                    !!s &&
                    s.attachments.length > 0 &&
                    s.attachments.every((a) => s.checked.has(a.id))
                  // A clone's summary is normally word-for-word the ticket's own, so showing it
                  // here just repeats the title field. Show it only when it actually differs.
                  const distinctSummary =
                    link.summary && link.summary !== step.preview.summary ? link.summary : null
                  return (
                    <div key={link.key} className="flex flex-col gap-1">
                      <button
                        type="button"
                        aria-expanded={open}
                        className="flex items-center gap-2 rounded-r1 border border-hair px-2 py-1 text-left text-xs hover:bg-hi"
                        onClick={() => void expandSource(link.key)}
                      >
                        <ChevronRight
                          size={12}
                          className={`shrink-0 text-mute transition-transform ${open ? 'rotate-90' : ''}`}
                        />
                        <span className="shrink-0 whitespace-nowrap font-mono text-defect">
                          Cloned from {link.key}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-dim">
                          {distinctSummary ?? ''}
                        </span>
                        {/* A collapsed row still carries a decision, so the header states it —
                            otherwise closing the row reads as having cancelled it. */}
                        <span className="shrink-0 text-mute">
                          {s?.loading
                            ? 'loading…'
                            : s?.error
                              ? 'retry'
                              : s
                                ? s.included
                                  ? `including · ${s.checked.size}/${s.attachments.length} ${s.attachments.length === 1 ? 'file' : 'files'}`
                                  : `${s.attachments.length} ${s.attachments.length === 1 ? 'file' : 'files'}`
                                : 'show attachments'}
                        </span>
                      </button>
                      {s?.error && <span className="px-2 text-xs text-mute">{s.error}</span>}
                      {s && open && !s.loading && !s.error && (
                        // No left padding: every checkbox in this dialog sits in one column, so
                        // the eye can run straight down them. The bordered header above is what
                        // says these rows belong to the clone.
                        <div className="flex min-h-0 flex-col gap-1">
                          {/* Independent of the attachment checkboxes below: a source with no
                              files still has ticket text and comments worth importing, and this
                              is the only way to say yes to those without a file to tick. */}
                          <label className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs hover:bg-hi">
                            <input
                              type="checkbox"
                              className="shrink-0"
                              aria-label={`Include ${link.key}`}
                              checked={s.included}
                              onChange={(e) => toggleSourceIncluded(link.key, e.target.checked)}
                            />
                            <span className="min-w-0 flex-1 text-ink">
                              Include {link.key} (ticket text &amp; comments)
                            </span>
                          </label>
                          {/* The source's own attachments header, built exactly like the
                              primary's above. The toggle-all used to sit on the include row,
                              where it read as belonging to that checkbox — a control that
                              takes every file must not look like part of the "import the
                              ticket text" decision. */}
                          {s.attachments.length > 0 && (
                            <div className="flex items-center gap-2 border-b border-hair pb-1 text-xs">
                              <span className="uppercase tracking-wide text-dim">
                                {link.key} attachments ({s.attachments.length})
                              </span>
                              <Btn
                                variant="outline"
                                className="ml-auto"
                                aria-label={`${allChecked ? 'Deselect' : 'Select'} all ${link.key} attachments`}
                                onClick={() => toggleSourceAll(link.key, !allChecked)}
                              >
                                {allChecked ? 'Deselect all' : 'Select all'}
                              </Btn>
                            </div>
                          )}
                          <div className="flex max-h-40 min-h-0 flex-col gap-1 overflow-y-auto">
                            {s.attachments.map((a) => (
                              <label
                                key={a.id}
                                className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs hover:bg-hi"
                              >
                                <input
                                  type="checkbox"
                                  className="shrink-0"
                                  checked={s.checked.has(a.id)}
                                  onChange={(e) =>
                                    toggleSourceAttachment(link.key, a.id, e.target.checked)
                                  }
                                />
                                <span className="min-w-0 flex-1 truncate font-mono text-ink">
                                  {a.filename}
                                </span>
                                <span className="shrink-0 text-mute">{kb(a.size)}</span>
                              </label>
                            ))}
                            {s.attachments.length === 0 && (
                              <span className="text-xs text-mute">no attachments</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
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
                      <>
                        <Chip tone="signal">done</Chip>
                        {f.dedupedFrom && (
                          <span
                            className="max-w-40 truncate text-mute"
                            title={`Already present from ${f.dedupedFrom}`}
                          >
                            already on {f.dedupedFrom}
                          </span>
                        )}
                      </>
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
