import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { MessageView } from './MessageView'
import { Btn, Chip } from './ui'
import { usePendingDisplay } from '../lib/usePendingDisplay'
import { confirm as confirmDialog } from '../lib/confirmStore'
import { panelsStore } from '../lib/panelsStore'
import { useSettingsPayload } from '../lib/settingsStore'
import { blurOnEscape } from '../lib/escapeLayer'
import {
  applyClaims,
  buildAssignments,
  CLAIM_ROLES,
  detachClaim,
  draftToClaims,
  reassign,
  ROLE_LABEL,
  targetsMessage,
  TARGET_LABEL,
  type Claim,
  type ClaimRole
} from '../lib/rcaDraft'
import type { FindingRole } from '../../../shared/observability'
import type { PostResults, PostTargetResult, RcaStatusPayload } from '../../../shared/rca'

function ClaimCard({
  claim,
  onRoleChange,
  onDetach
}: {
  claim: Claim
  onRoleChange: (role: ClaimRole) => void
  onDetach: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-r2 border border-hair p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-ink">{claim.statement || '(no statement)'}</p>
        <select
          aria-label={`Role for finding ${claim.findingId ?? `unlinked (${claim.key})`}`}
          value={claim.role}
          onChange={(e) => onRoleChange(e.target.value as ClaimRole)}
          onKeyDown={blurOnEscape}
          className="shrink-0 rounded-r1 border border-hair bg-overlay px-1 py-0.5 text-[11px] text-ink"
        >
          {CLAIM_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
          <option value="unclassified">Unclassified</option>
        </select>
      </div>
      {claim.findingId !== null && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10.5px] text-mute">finding {claim.findingId}</span>
          <button
            type="button"
            aria-label={`Detach finding ${claim.findingId}`}
            title="Keep this claim's text, but stop linking it to that finding"
            onClick={onDetach}
            className="text-[10.5px] text-mute underline underline-offset-2 hover:text-ink"
          >
            Detach
          </button>
        </div>
      )}
      {claim.why && <p className="text-mute">{claim.why}</p>}
      {claim.evidence.length > 0 && (
        <ul className="flex flex-col gap-0.5 border-t border-hair pt-1">
          {claim.evidence.map((c, i) => (
            <li key={i} className="font-mono text-[10.5px] text-mute">
              {c.path}
              {c.line != null ? `:${c.line}` : ''}
              {c.evidence && <div className="whitespace-pre-wrap text-mute">{c.evidence}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const SECTIONS: { role: Exclude<FindingRole, 'duplicate'>; label: string }[] = [
  { role: 'root-cause', label: 'Root cause' },
  { role: 'contributing', label: 'Contributing' },
  { role: 'symptom', label: 'Symptoms' },
  { role: 'ruled-out', label: 'Ruled out' }
]

/**
 * Review UI for a case's RCA report (task-11 brief): drives entirely off `RcaStatusPayload`
 * (`generate`/`status`/`onRcaChanged`), lets the user re-classify claims and veto duplicate
 * rows against a local copy of the `done` job's draft, previews the two rendered reports over
 * that edited draft, then confirms (freezing roles + artifacts) and optionally posts to Jira.
 */
export function RcaPanel({
  slug,
  onClose
}: {
  slug: string
  onClose: () => void
}): React.JSX.Element {
  // Same occlusion registration as PrPickerDialog: a docked panel is a native WebContentsView
  // that paints above all DOM, so any component-level modal must hide it while open.
  const modalId = useId()
  useEffect(() => panelsStore.registerModal(modalId), [modalId])

  const settingsPayload = useSettingsPayload()

  const [payload, setPayload] = useState<RcaStatusPayload | null>(null)
  const [claims, setClaims] = useState<Claim[]>([])
  const [vetoed, setVetoed] = useState<Set<number>>(new Set())
  const [postResults, setPostResults] = useState<PostResults | null>(null)
  const initedJobId = useRef<number | null>(null)

  const [tab, setTab] = useState<'exec' | 'tech'>('exec')
  const [preview, setPreview] = useState<{ exec: string; tech: string } | null>(null)

  const [investigationFindingsCount, setInvestigationFindingsCount] = useState<number | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [postBusy, setPostBusy] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  // Poll on mount, then stay live via the broadcast — `RcaJobs` emits on every generate/state
  // transition/confirm, so no interval polling is needed once the first fetch lands.
  useEffect(() => {
    let live = true
    void window.argus.rca.status(slug).then((p) => {
      if (live) setPayload(p)
    })
    const unsub = window.argus.rca.onRcaChanged((p) => {
      if (live && p.caseSlug === slug) setPayload(p)
    })
    return () => {
      live = false
      unsub()
    }
  }, [slug])

  useEffect(() => {
    let live = true
    void window.argus.findings.list(slug).then((rows) => {
      if (live) setInvestigationFindingsCount(rows.filter((r) => r.mode === 'investigation').length)
    })
    return () => {
      live = false
    }
  }, [slug])

  const job = payload?.job ?? null
  const draft = payload?.draft ?? null

  // Seeds the editable claims copy from the draft exactly once per `done` job — re-running
  // this on every payload update (e.g. the broadcast `confirm()` triggers) would silently
  // discard whatever the user had already re-classified in this session.
  useEffect(() => {
    if (job && job.state === 'done' && draft && job.id !== initedJobId.current) {
      initedJobId.current = job.id
      setClaims(draftToClaims(draft))
      setVetoed(new Set())
      setPostResults(job.postResults)
      setConfirmError(null)
      setPostError(null)
    }
  }, [job, draft])

  const isRunning = job?.state === 'queued' || job?.state === 'running'
  const showRunning = usePendingDisplay(isRunning)

  const editedDraft = useMemo(() => (draft ? applyClaims(draft, claims) : null), [draft, claims])

  // No `else setPreview(null)` branch: a stale preview from a since-cleared draft is harmless —
  // the previews block below only renders inside the `done && draft` branch, so `editedDraft`
  // going null also means nothing reads `preview` until a new `done` job seeds a fresh one.
  useEffect(() => {
    if (!editedDraft) return
    let live = true
    void window.argus.rca.renderPreview(slug, editedDraft).then((p) => {
      if (live) setPreview(p)
    })
    return () => {
      live = false
    }
  }, [slug, editedDraft])

  function setRole(key: string, role: ClaimRole): void {
    setClaims((prev) => reassign(prev, key, role))
  }

  function onDetach(key: string): void {
    setClaims((prev) => detachClaim(prev, key))
  }

  function toggleVeto(findingId: number): void {
    setVetoed((prev) => {
      const next = new Set(prev)
      if (next.has(findingId)) next.delete(findingId)
      else next.add(findingId)
      return next
    })
  }

  async function onGenerate(): Promise<void> {
    setGenerateError(null)
    try {
      await window.argus.rca.generate(slug)
    } catch (err) {
      setGenerateError((err as Error).message)
    }
  }

  async function onRegenerateClick(): Promise<void> {
    const ok = await confirmDialog({
      title: 'Regenerate the RCA report?',
      message:
        "Discards your in-panel edits for this draft and starts a fresh generation. A confirmed report's roles and artifacts stay as they are until you confirm the new draft."
    })
    if (!ok) return
    await onGenerate()
  }

  // Re-fetches status on a confirm failure (in addition to showing the error) so the panel
  // recovers on its own: the most likely failure is `applyReportRoles`'s "does not belong"
  // error for a finding deleted/moved since the draft was generated — the user needs live
  // state (e.g. to Detach that claim) rather than a frozen view stuck on the failed attempt.
  async function refetchStatus(): Promise<void> {
    try {
      setPayload(await window.argus.rca.status(slug))
    } catch {
      // best-effort: the confirm error above stays visible either way
    }
  }

  async function onConfirmFreeze(): Promise<void> {
    if (!job || !editedDraft) return
    if (!editedDraft.rootCause.statement) {
      const ok = await confirmDialog({
        title: 'No root cause selected',
        message:
          'This report has no root cause claim right now — Confirm & freeze will save it without a root cause. Continue?'
      })
      if (!ok) return
    }
    setConfirmBusy(true)
    setConfirmError(null)
    try {
      const assignments = buildAssignments(editedDraft, vetoed)
      await window.argus.rca.confirm(slug, job.id, assignments, editedDraft)
    } catch (err) {
      setConfirmError((err as Error).message)
      await refetchStatus()
    } finally {
      setConfirmBusy(false)
    }
  }

  async function doPost(): Promise<void> {
    setPostBusy(true)
    setPostError(null)
    try {
      setPostResults(await window.argus.rca.post(slug))
    } catch (err) {
      setPostError((err as Error).message)
    } finally {
      setPostBusy(false)
    }
  }

  async function onPostClick(): Promise<void> {
    const cfg = settingsPayload?.settings.rca
    const ok = await confirmDialog({
      title: 'Post RCA to Jira?',
      message: targetsMessage(cfg?.techDestination ?? 'attachment', cfg?.confluenceSpaceKey ?? '')
    })
    if (!ok) return
    await doPost()
  }

  return (
    <ModalShell
      title={
        <>
          <FileText size={14} strokeWidth={1.5} />
          RCA report
        </>
      }
      ariaLabel="RCA report"
      onClose={onClose}
      className="h-[85vh] w-[880px]"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {payload === null ? (
          <p className="text-xs text-mute">Loading…</p>
        ) : !job || job.state === 'failed' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            {job?.state === 'failed' && (
              <p role="alert" className="max-w-md text-center text-sm text-danger">
                {job.error}
              </p>
            )}
            <Btn
              variant="primary"
              disabled={investigationFindingsCount === 0}
              title={
                investigationFindingsCount === 0
                  ? 'No investigation findings yet — nothing to summarize.'
                  : undefined
              }
              onClick={() => void onGenerate()}
            >
              {job?.state === 'failed' ? 'Regenerate' : 'Generate RCA report'}
            </Btn>
            {generateError && <p className="text-xs text-danger">{generateError}</p>}
          </div>
        ) : isRunning ? (
          showRunning && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-mute">
              <p>{job.state === 'queued' ? 'Queued…' : 'Generating the RCA report…'}</p>
            </div>
          )
        ) : job.state === 'done' && draft ? (
          <>
            {/* — Claims — */}
            <div className="flex flex-col gap-3">
              {SECTIONS.map(({ role, label }) => {
                const rows = claims.filter((c) => c.role === role)
                if (rows.length === 0) return null
                return (
                  <section key={role} className="flex flex-col gap-1.5">
                    <h3 className="text-[10.5px] font-medium uppercase tracking-wide text-mute">
                      {label}
                    </h3>
                    <div className="flex flex-col gap-1.5">
                      {rows.map((c) => (
                        <ClaimCard
                          key={c.key}
                          claim={c}
                          onRoleChange={(r) => setRole(c.key, r)}
                          onDetach={() => onDetach(c.key)}
                        />
                      ))}
                    </div>
                  </section>
                )
              })}
              {draft.duplicates.length > 0 && (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[10.5px] font-medium uppercase tracking-wide text-mute">
                    Duplicates
                  </h3>
                  <div className="flex flex-col gap-1">
                    {draft.duplicates.map((d) => (
                      <label
                        key={d.findingId}
                        className="flex items-center gap-2 rounded-r1 px-1 py-0.5 text-xs text-ink"
                      >
                        <input
                          type="checkbox"
                          aria-label={`Veto duplicate finding ${d.findingId}`}
                          checked={vetoed.has(d.findingId)}
                          onChange={() => toggleVeto(d.findingId)}
                        />
                        finding {d.findingId} — duplicate of finding {d.ofFindingId}
                        {vetoed.has(d.findingId) && <Chip tone="neutral">vetoed</Chip>}
                      </label>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* — Previews — */}
            <div className="flex flex-col gap-2 border-t border-hair pt-3">
              <div className="flex items-center gap-1">
                {(['exec', 'tech'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={tab === t}
                    onClick={() => setTab(t)}
                    className={`rounded-r1 border px-2 py-0.5 text-[11px] transition-colors ${
                      tab === t
                        ? 'border-signal bg-signal/15 text-ink'
                        : 'border-hair2 text-mute hover:text-ink'
                    }`}
                  >
                    {t === 'exec' ? 'Exec summary' : 'Technical report'}
                  </button>
                ))}
              </div>
              {preview && <MessageView markdown={preview[tab]} onCite={() => {}} caseSlug={slug} />}
            </div>

            {/* — Actions — */}
            <div className="flex flex-col gap-2 border-t border-hair pt-3">
              <div className="flex items-center gap-2">
                <Btn
                  variant="primary"
                  disabled={confirmBusy}
                  onClick={() => void onConfirmFreeze()}
                >
                  {confirmBusy ? 'Confirming…' : 'Confirm & freeze'}
                </Btn>
                <Btn disabled={confirmBusy} onClick={() => void onRegenerateClick()}>
                  Regenerate
                </Btn>
                {job.confirmedAt && (
                  <Btn disabled={postBusy} onClick={() => void onPostClick()}>
                    {postBusy ? 'Posting…' : 'Post to Jira'}
                  </Btn>
                )}
                {job.confirmedAt && <Chip tone="review">confirmed</Chip>}
              </div>
              {confirmError && <p className="text-xs text-danger">{confirmError}</p>}
              {postError && <p className="text-xs text-danger">{postError}</p>}
              {postResults && (
                <div className="flex flex-col gap-1">
                  {(Object.keys(postResults) as (keyof PostResults)[]).map((key) => {
                    const r = postResults[key] as PostTargetResult | undefined
                    if (!r) return null
                    return (
                      <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-ink">{TARGET_LABEL[key]}</span>
                        {r.ok ? (
                          <Chip tone="signal">posted</Chip>
                        ) : (
                          <Chip tone="danger">failed</Chip>
                        )}
                        {r.url && (
                          <a
                            href={r.url}
                            className="truncate text-mute underline underline-offset-2"
                          >
                            {r.url}
                          </a>
                        )}
                        {!r.ok && r.error && <span className="text-danger">{r.error}</span>}
                        {!r.ok && (
                          <Btn
                            aria-label={`Retry ${TARGET_LABEL[key]}`}
                            disabled={postBusy}
                            onClick={() => void doPost()}
                          >
                            Retry
                          </Btn>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </ModalShell>
  )
}
