import { useEffect, useState } from 'react'
import { Inbox, X } from 'lucide-react'
import { IconBtn } from '../ui'
import { ProposalQueue, type QueueEntry } from './ProposalQueue'
import { ProposalDetail, type AcceptedEntry } from './ProposalDetail'
import type { DiffViewMode } from './DiffViews'
import { KnowledgeFlowStrip } from '../settings/KnowledgeFlowStrip'
import { SettingsSkeleton } from '../settings/settingsLayout'
import { useSettingsPayload } from '../../lib/settingsStore'
import { useProposalCounts } from '../../lib/proposalsStore'
import { useEscapeLayer } from '../../lib/escapeLayer'
import { useAmbientAnchors } from '../../lib/ambientAnchors'
import type { ProposalRecord, ProposalsPayload, ProposalType } from '../../../../shared/proposals'

/** Top-level work surface, not a Settings page — same standing as
 *  RelatedHistoryStandalone: this is work, not configuration. */
export function ProposalsStandalone({
  initialTypes,
  onClose,
  onNavigateSettings
}: {
  initialTypes?: readonly ProposalType[]
  onClose: () => void
  onNavigateSettings: (page: 'sources' | 'library' | 'team') => void
}): React.JSX.Element {
  const [payload, setPayload] = useState<ProposalsPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<ReadonlySet<ProposalType>>(new Set(initialTypes ?? []))
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [accepted, setAccepted] = useState<AcceptedEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified')
  const settings = useSettingsPayload()
  const repoSet = (settings?.settings.hivemind.repo ?? '').trim() !== ''
  const counts = useProposalCounts()
  const anchors = useAmbientAnchors()

  useEscapeLayer({ onEscape: onClose })

  // Fetch on mount, refetch on every proposals:changed broadcast — same contract
  // as the old ProposalsPage: the TopBar badge and this view read one source.
  useEffect(() => {
    let stale = false
    void window.argus.proposals
      .list()
      .then((p) => {
        if (!stale) {
          setPayload(p)
          // A background refetch that resolves clears any alert left over from an
          // earlier transient failure — otherwise a single dropped IPC call leaves
          // the banner up forever even after the list is fresh again.
          setError(null)
        }
      })
      .catch((e) => {
        if (!stale) {
          setPayload((prev) => prev ?? { proposals: [] })
          setError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      stale = true
    }
  }, [counts])

  async function act(fn: () => Promise<ProposalsPayload>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setPayload(await fn())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const typesPresent = Array.from(new Set((payload?.proposals ?? []).map((p) => p.type)))
  // active may contain types no longer present (e.g. the last proposal of that type was just
  // accepted/rejected) — intersect with what's actually here so a stale chip can't hide everything.
  const effective = new Set([...active].filter((t) => typesPresent.includes(t)))
  const matches = (t: ProposalType): boolean => effective.size === 0 || effective.has(t)

  // Same comparator as the old ProposalsPage: caseSlug asc, then date desc (spec:
  // "sorted as today"). Newest proposal within a case leads the queue.
  const byCase = (
    a: { caseSlug: string; date: string },
    b: { caseSlug: string; date: string }
  ): number => a.caseSlug.localeCompare(b.caseSlug) || b.date.localeCompare(a.date)

  const pendingSorted = (payload?.proposals ?? []).filter((p) => matches(p.type)).sort(byCase)
  // A same-day re-distill can regenerate the identical proposals/ filename after accept
  // archives the original (writeProposal only uniquifies against files still present) — so a
  // session-accepted row can share a `file` with a freshly re-proposed pending row. Drop the
  // accepted row in that case: the pending row is what's actionable, and keeping both would
  // hand ProposalQueue two entries with the same React key.
  const acceptedVisible = accepted
    .filter((a) => matches(a.type))
    .filter((a) => !pendingSorted.some((p) => p.file === a.file))
  const entries: QueueEntry[] = [
    ...pendingSorted.map((p) => ({
      kind: 'pending' as const,
      file: p.file,
      title: p.title,
      caseSlug: p.caseSlug,
      date: p.date,
      type: p.type,
      target: p.type === 'case-summary' ? '' : p.target,
      isNew: p.current === null,
      locked: Boolean(p.locked),
      previouslyReviewed: Boolean(p.previouslyReviewed)
    })),
    ...acceptedVisible.map((a) => ({
      kind: 'accepted' as const,
      file: a.file,
      title: a.title,
      caseSlug: a.caseSlug,
      date: a.date,
      type: a.type,
      target: a.target.kind === 'case-summary' ? '' : a.target.name,
      isNew: false,
      locked: false,
      previouslyReviewed: false
    }))
  ].sort(byCase)

  const effectiveSelected =
    selectedFile !== null && entries.some((e) => e.file === selectedFile)
      ? selectedFile
      : (entries[0]?.file ?? null)
  const selectedPending = pendingSorted.find((p) => p.file === effectiveSelected) ?? null
  // Pending wins over a same-file accepted row (see acceptedVisible above) — this is
  // belt-and-suspenders since the dedupe already keeps them out of `entries` together, but it
  // keeps this derivation correct on its own terms too.
  const selectedAccepted = selectedPending
    ? null
    : (acceptedVisible.find((a) => a.file === effectiveSelected) ?? null)
  const position = selectedPending
    ? {
        index: pendingSorted.findIndex((p) => p.file === selectedPending.file) + 1,
        total: pendingSorted.length
      }
    : null

  // Commit the entries[0] fallback into state once we actually have a list: without this,
  // `effectiveSelected` above recomputes its fallback on every render, so a background refetch
  // that changes which proposal sorts first (a new proposal landing ahead of the one on screen)
  // silently retargets Accept/Reject at a DIFFERENT proposal than the one the user is looking
  // at. selectedFile stays null until this fires, so the retarget window is real, not
  // hypothetical. Adopted from a microtask, the repo's usual set-state-in-effect idiom (see
  // TextViewer's page-cache effect) — there is no same-commit requirement here.
  useEffect(() => {
    if (selectedFile !== null || !entries[0]) return
    const file = entries[0].file
    void Promise.resolve().then(() => setSelectedFile(file))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, entries[0]?.file])

  if (!payload) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <SettingsSkeleton rows={6} />
      </div>
    )
  }

  function toggleType(t: ProposalType): void {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  function toggleEdit(p: ProposalRecord): void {
    setEditing((prev) => {
      const next = { ...prev }
      if (p.file in next) delete next[p.file]
      else next[p.file] = p.content
      return next
    })
  }

  // A stale draft must not attach to a future same-name re-proposal (same-day re-distill can
  // regenerate the identical filename once the original is archived out of the way) — prune it
  // on every path that removes `p` from the pending list.
  function pruneEditing(file: string): void {
    setEditing((prev) => {
      if (!(file in prev)) return prev
      const next = { ...prev }
      delete next[file]
      return next
    })
  }

  function acceptSelected(p: ProposalRecord): void {
    const draft = p.file in editing ? editing[p.file] : undefined
    void act(async () => {
      const r = await (draft !== undefined
        ? window.argus.proposals.accept(p.file, draft)
        : window.argus.proposals.accept(p.file))
      // Replace, not append: accepting a same-named re-proposal must not leave two
      // session-accepted entries for one file (only the latest target is meaningful).
      setAccepted((prev) => [
        ...prev.filter((a) => a.file !== p.file),
        {
          file: p.file,
          title: p.title,
          caseSlug: p.caseSlug,
          date: p.date,
          type: p.type,
          target: r.accepted
        }
      ])
      pruneEditing(p.file)
      // Selection stays on p.file — the row flips to its accepted entry.
      setSelectedFile(p.file)
      return r
    })
  }

  function rejectSelected(
    p: ProposalRecord,
    reason: Parameters<typeof window.argus.proposals.reject>[1]
  ): void {
    // Compute the advance target from the CURRENT pending order before the
    // refetch drops the row: next pending, else previous, else null.
    const i = pendingSorted.findIndex((x) => x.file === p.file)
    const next = pendingSorted[i + 1] ?? pendingSorted[i - 1] ?? null
    void act(async () => {
      // Trust the IPC response the same way the old page's `act()` does — the
      // fresh `proposals` list is the source of truth (a distiller run may
      // have touched other rows too), not something to reconcile locally.
      const r = await window.argus.proposals.reject(p.file, reason)
      pruneEditing(p.file)
      setSelectedFile(next?.file ?? null)
      return r
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        // Ambient anchors, same claim/release pattern as RelatedHistoryStandalone.
        // eslint-disable-next-line react-hooks/refs
        ref={anchors.setCutoff}
        className="flex items-center justify-between border-b border-hair px-3 py-2"
      >
        <span
          // eslint-disable-next-line react-hooks/refs
          ref={anchors.setLight}
          className="flex items-center gap-2 font-mono text-sm text-ink"
        >
          <Inbox size={14} strokeWidth={1.5} />
          Proposals
          <span className="text-xs text-mute">· {pendingSorted.length} pending</span>
        </span>
        <IconBtn aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </IconBtn>
      </div>
      <div className="flex flex-col gap-3 px-4 pt-3">
        <KnowledgeFlowStrip
          current="proposals"
          onNavigate={(page) => {
            if (page !== 'proposals') onNavigateSettings(page)
          }}
        />
        {error && (
          <div
            role="alert"
            className="rounded-r2 border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink"
          >
            {error}
          </div>
        )}
      </div>
      <div className="m-4 flex min-h-0 flex-1 overflow-hidden rounded-r3 border border-hair surface-card">
        <ProposalQueue
          entries={entries}
          pendingCount={pendingSorted.length}
          typesPresent={typesPresent}
          countByType={Object.fromEntries(
            typesPresent.map((t) => [t, payload.proposals.filter((p) => p.type === t).length])
          )}
          activeTypes={active}
          onToggleType={toggleType}
          selectedFile={effectiveSelected}
          onSelect={setSelectedFile}
        />
        <ProposalDetail
          key={effectiveSelected ?? 'none'}
          proposal={selectedPending}
          accepted={selectedAccepted}
          busy={busy}
          editValue={
            selectedPending && selectedPending.file in editing
              ? editing[selectedPending.file]
              : null
          }
          onEditChange={(v) =>
            selectedPending && setEditing((prev) => ({ ...prev, [selectedPending.file]: v }))
          }
          onToggleEdit={() => selectedPending && toggleEdit(selectedPending)}
          viewMode={viewMode}
          onViewMode={setViewMode}
          position={position}
          repoSet={repoSet}
          onOpenHivemind={() => onNavigateSettings('team')}
          onAccept={() => selectedPending && acceptSelected(selectedPending)}
          onReject={(reason) => selectedPending && rejectSelected(selectedPending, reason)}
        />
      </div>
    </div>
  )
}
