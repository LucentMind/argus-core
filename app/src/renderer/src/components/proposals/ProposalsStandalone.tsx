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
        if (!stale) setPayload(p)
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

  if (!payload) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <SettingsSkeleton rows={6} />
      </div>
    )
  }

  // Narrowed once here: `payload` is non-null for the rest of this render, but
  // TS does not carry that across the nested closures below (act/reject/accept
  // callbacks), so this local alias is what lets them reference it safely.
  const currentProposals = payload.proposals
  const typesPresent = Array.from(new Set(currentProposals.map((p) => p.type)))
  // active may contain types no longer present (e.g. the last proposal of that type was just
  // accepted/rejected) — intersect with what's actually here so a stale chip can't hide everything.
  const effective = new Set([...active].filter((t) => typesPresent.includes(t)))
  const matches = (t: ProposalType): boolean => effective.size === 0 || effective.has(t)

  const byCase = (
    a: { caseSlug: string; date: string },
    b: { caseSlug: string; date: string }
  ): number => a.caseSlug.localeCompare(b.caseSlug) || a.date.localeCompare(b.date)

  const pendingSorted = currentProposals.filter((p) => matches(p.type)).sort(byCase)
  const acceptedVisible = accepted.filter((a) => matches(a.type))
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
  const selectedAccepted = acceptedVisible.find((a) => a.file === effectiveSelected) ?? null
  const position = selectedPending
    ? {
        index: pendingSorted.findIndex((p) => p.file === selectedPending.file) + 1,
        total: pendingSorted.length
      }
    : null

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

  function acceptSelected(p: ProposalRecord): void {
    const draft = p.file in editing ? editing[p.file] : undefined
    void act(async () => {
      const r = await (draft !== undefined
        ? window.argus.proposals.accept(p.file, draft)
        : window.argus.proposals.accept(p.file))
      setAccepted((prev) => [
        ...prev,
        {
          file: p.file,
          title: p.title,
          caseSlug: p.caseSlug,
          date: p.date,
          type: p.type,
          target: r.accepted
        }
      ])
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
      await window.argus.proposals.reject(p.file, reason)
      setSelectedFile(next?.file ?? null)
      // Drop the rejected file locally rather than trusting the IPC response's
      // `proposals` list verbatim — the eventual proposals:changed broadcast
      // (via useProposalCounts) is what reconciles with the server's real
      // state; this optimistic removal is what makes the untouched rows (and
      // the advanced selection) survive the round trip without waiting on it.
      return { proposals: currentProposals.filter((x) => x.file !== p.file) }
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
            typesPresent.map((t) => [t, currentProposals.filter((p) => p.type === t).length])
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
