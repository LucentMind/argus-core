import { useEffect, useState } from 'react'
import { ProposalQueue, type QueueEntry } from './ProposalQueue'
import { ProposalDetail, type AcceptedEntry } from './ProposalDetail'
import { RejectDigestPanel } from './RejectDigestPanel'
import { BODY_PATH } from './FileRail'
import type { DiffViewMode } from './DiffViews'
import { KnowledgeFlowStrip } from '../settings/KnowledgeFlowStrip'
import { SettingsSkeleton } from '../settings/settingsLayout'
import { useSettingsPayload } from '../../lib/settingsStore'
import { useProposalCounts } from '../../lib/proposalsStore'
import { useEscapeLayer } from '../../lib/escapeLayer'
import { viewTitleStore } from '../../lib/viewTitleStore'
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
  // file -> (relative path | BODY_PATH) -> draft. Two levels because one proposal now has many
  // editable documents; the body keeps `BODY_PATH` so `acceptProposal`'s `editedContent`
  // contract is unchanged.
  //
  // This is the buffer ALONE — never the "is this pane showing the textarea" fact too. It used
  // to carry both (presence in the map doubled as edit-mode), and toggling the view to "View
  // diff" turned edit mode off by deleting the entry outright, taking the draft with it —
  // reviewing an edit before accepting silently discarded it, and `acceptSelected` below reads
  // this same map, so Accept then shipped the untouched original with nothing on screen to say
  // so. `editMode` (below) now owns the mode; this owns only the text, and nothing but
  // `pruneEditing`/`discardDraft`/accept/reject ever removes an entry from it.
  const [editing, setEditing] = useState<Record<string, Record<string, string>>>({})
  // file -> set of paths currently showing the edit textarea for that file. A path can have a
  // buffer in `editing` without being in this set — that's toggled off ("View diff"/"View"),
  // and the buffer is exactly what that view now reflects (see `onEditChange`'s sibling prop
  // wiring below and `ProposalDetail`'s `displayContent`).
  const [editMode, setEditMode] = useState<Record<string, ReadonlySet<string>>>({})
  const [accepted, setAccepted] = useState<AcceptedEntry[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  // Which path is selected in the rail, scoped to the proposal it was recorded against. Derived
  // rather than reset by an effect: a plain `useEffect(() => setSelectedPath(BODY_PATH), [dep])`
  // both trips this repo's `react-hooks/set-state-in-effect` lint (a synchronous setState in an
  // effect body) and keys on the wrong value — `selectedFile` stays null until the entries[0]
  // fallback effect below commits, so the first render(s) would key against a value that hasn't
  // caught up with `effectiveSelected`, the value that actually decides which proposal is shown.
  // Scoping the recorded selection to the `file` it was made against means a stale path can never
  // leak onto a different proposal, and there is no frame where a mismatched path is live.
  const [pathSel, setPathSel] = useState<{ file: string; path: string } | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified')
  const settings = useSettingsPayload()
  const repoSet = (settings?.settings.hivemind.repo ?? '').trim() !== ''
  const counts = useProposalCounts()

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
  //
  // The `file` tiebreak is what keeps a row STILL when it is accepted. One distill run stages its
  // proposals in a synchronous loop, so several of them routinely carry the identical
  // `new Date().toISOString()` stamp; with caseSlug+date alone the comparator returns 0 for those
  // and the stable sort falls back to array order — where every pending row precedes every
  // accepted one (see `entries` below). Accepting therefore threw the row to the bottom of its
  // tie group. `file` is unique and unchanged by accept, so the row now holds its slot.
  const byCase = (
    a: { caseSlug: string; date: string; file: string },
    b: { caseSlug: string; date: string; file: string }
  ): number =>
    a.caseSlug.localeCompare(b.caseSlug) ||
    b.date.localeCompare(a.date) ||
    a.file.localeCompare(b.file)

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
      previouslyReviewed: Boolean(p.previouslyReviewed),
      hasExec: (p.files ?? []).some((f) => f.exec)
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
      previouslyReviewed: false,
      hasExec: a.hasExec
    }))
  ].sort(byCase)

  const effectiveSelected =
    selectedFile !== null && entries.some((e) => e.file === selectedFile)
      ? selectedFile
      : (entries[0]?.file ?? null)
  const selectedPending = pendingSorted.find((p) => p.file === effectiveSelected) ?? null
  // A recorded selection only applies to the proposal it was made against, AND only to a path
  // that record still carries — a supersede flow (accept archives a proposal, a same-day
  // re-distill regenerates the identical filename with a different sibling set: writeProposal
  // only uniquifies against files still present) can leave `pathSel` naming a sibling the fresh
  // record no longer has, even though `pathSel.file === effectiveSelected` still holds. Without
  // the second check, `selectedPath` would name a vanished path — ProposalDetail falls back to
  // rendering the body while the edit buffer stays keyed to the invisible path, so Edit opens an
  // empty textarea and Accept fails in main with "edited file not in the proposal".
  const selPathOk =
    pathSel?.path === BODY_PATH ||
    (selectedPending?.files ?? []).some((f) => f.path === pathSel?.path)
  const selectedPath =
    pathSel && pathSel.file === effectiveSelected && selPathOk ? pathSel.path : BODY_PATH
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

  // The header renders this view's title (user-directed, 2026-08-08) — the second bar that used
  // to carry it, and a close button, is gone: it cost ~34px of height on a view whose header
  // already had room, and Settings had already proved the pattern. Escape (above) and the top
  // bar's own Proposals toggle both still close the view, which is exactly how Settings closes.
  //
  // Two effects rather than one with a cleanup, for the same reason as SettingsView: a single
  // effect would publish `null` on every count change before republishing, and this one's deps
  // move whenever a proposal is accepted or rejected.
  // No count until the list is in hand — the skeleton would otherwise claim "0 pending" for as
  // long as the fetch takes, which is a statement, not a placeholder.
  const titleDetail = payload ? `· ${pendingSorted.length} pending` : undefined
  useEffect(() => {
    viewTitleStore.publish({ label: 'Proposals', detail: titleDetail })
  }, [titleDetail])
  useEffect(() => () => viewTitleStore.publish(null), [])

  if (!payload) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <SettingsSkeleton rows={6} />
      </div>
    )
  }

  // One chip covers a whole icon family (Skill = new + edit), so
  // a click sets or clears every type behind it at once — half-on has no chip that can express it.
  function toggleTypes(types: readonly ProposalType[], on: boolean): void {
    setActive((prev) => {
      const next = new Set(prev)
      for (const t of types) {
        if (on) next.add(t)
        else next.delete(t)
      }
      return next
    })
  }

  // Flips the VIEW between the edit textarea and the diff/preview — it must never touch whether
  // a draft exists. Entering edit mode for a path with no buffer yet seeds one from the proposal
  // (first edit); every other toggle just flips membership in `editMode`, leaving `editing`
  // alone so the draft survives "View diff" and comes back exactly as typed.
  function toggleEdit(p: ProposalRecord): void {
    const path = selectedPath
    const hasBuffer = path in (editing[p.file] ?? {})
    if (!hasBuffer) {
      const seed =
        path === BODY_PATH ? p.content : (p.files?.find((f) => f.path === path)?.content ?? '')
      setEditing((prev) => ({ ...prev, [p.file]: { ...(prev[p.file] ?? {}), [path]: seed } }))
    }
    setEditMode((prev) => {
      const forFile = new Set(prev[p.file] ?? [])
      if (forFile.has(path)) forFile.delete(path)
      else forFile.add(path)
      const next = { ...prev }
      if (forFile.size === 0) delete next[p.file]
      else next[p.file] = forFile
      return next
    })
  }

  // A stale draft must not attach to a future same-name re-proposal (same-day re-distill can
  // regenerate the identical filename once the original is archived out of the way) — prune it
  // on every path that removes `p` from the pending list. Prunes the view-mode flags with it, so
  // a resurrected filename can't inherit a stray "showing the textarea" state either.
  function pruneEditing(file: string): void {
    setEditing((prev) => {
      if (!(file in prev)) return prev
      const next = { ...prev }
      delete next[file]
      return next
    })
    setEditMode((prev) => {
      if (!(file in prev)) return prev
      const next = { ...prev }
      delete next[file]
      return next
    })
  }

  // Explicit discard (requirement 4): the only way left to throw a draft away, now that toggling
  // the view no longer does it implicitly. Confirmed by the caller (ProposalDetail) before this
  // runs. Also drops edit mode for the path — there is nothing left to show a textarea for.
  function discardDraft(file: string, path: string): void {
    setEditing((prev) => {
      const forFile = prev[file]
      if (!forFile || !(path in forFile)) return prev
      const nextForFile = { ...forFile }
      delete nextForFile[path]
      const next = { ...prev }
      if (Object.keys(nextForFile).length === 0) delete next[file]
      else next[file] = nextForFile
      return next
    })
    setEditMode((prev) => {
      const forFile = prev[file]
      if (!forFile?.has(path)) return prev
      const nextForFile = new Set(forFile)
      nextForFile.delete(path)
      const next = { ...prev }
      if (nextForFile.size === 0) delete next[file]
      else next[file] = nextForFile
      return next
    })
  }

  function acceptSelected(p: ProposalRecord): void {
    const drafts = editing[p.file] ?? {}
    const body = BODY_PATH in drafts ? drafts[BODY_PATH] : undefined
    const siblings = Object.fromEntries(
      Object.entries(drafts).filter(([path]) => path !== BODY_PATH)
    )
    // undefined, not {}: main treats an absent map as "no per-file edits", and an empty object
    // would archive an `edited_files:` stamp for edits that do not exist.
    const files = Object.keys(siblings).length > 0 ? siblings : undefined
    void act(async () => {
      const r = await window.argus.proposals.accept(p.file, body, files)
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
          target: r.accepted,
          hasExec: (p.files ?? []).some((f) => f.exec)
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
    // No title row of its own: TopBar carries the title, and the ambient anchors with it (the
    // header claims both whenever `viewTitleStore` is non-null).
    <div className="flex min-h-0 flex-1 flex-col">
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
        <RejectDigestPanel />
      </div>
      <div className="m-4 flex min-h-0 flex-1 overflow-hidden rounded-r3 border border-hair surface-card">
        <ProposalQueue
          entries={entries}
          typesPresent={typesPresent}
          countByType={Object.fromEntries(
            typesPresent.map((t) => [t, payload.proposals.filter((p) => p.type === t).length])
          )}
          activeTypes={active}
          onToggleTypes={toggleTypes}
          selectedFile={effectiveSelected}
          onSelect={setSelectedFile}
        />
        <ProposalDetail
          key={effectiveSelected ?? 'none'}
          proposal={selectedPending}
          accepted={selectedAccepted}
          busy={busy}
          editValue={
            selectedPending && editing[selectedPending.file]?.[selectedPath] !== undefined
              ? editing[selectedPending.file][selectedPath]
              : null
          }
          onEditChange={(v) =>
            selectedPending &&
            setEditing((prev) => ({
              ...prev,
              [selectedPending.file]: { ...(prev[selectedPending.file] ?? {}), [selectedPath]: v }
            }))
          }
          onToggleEdit={() => selectedPending && toggleEdit(selectedPending)}
          isEditing={Boolean(selectedPending && editMode[selectedPending.file]?.has(selectedPath))}
          onDiscardDraft={() => selectedPending && discardDraft(selectedPending.file, selectedPath)}
          viewMode={viewMode}
          onViewMode={setViewMode}
          position={position}
          repoSet={repoSet}
          onOpenHivemind={() => onNavigateSettings('team')}
          onAccept={() => selectedPending && acceptSelected(selectedPending)}
          onReject={(reason) => selectedPending && rejectSelected(selectedPending, reason)}
          selectedPath={selectedPath}
          onSelectPath={(path) =>
            effectiveSelected && setPathSel({ file: effectiveSelected, path })
          }
          // A buffer's mere presence is the marker — not diffed against the original — so the
          // rail flags an edit that reverts to the source text too. That's an accepted
          // over-approximation, not a bug: this task does not build change-detection. The
          // buffer now outlives toggling to "View diff" (see `editing` above), so the marker
          // does too — a reviewer who checks the diff no longer sees the "edited" flag vanish
          // out from under an edit that is still there.
          editedPaths={
            new Set(Object.keys(selectedPending ? (editing[selectedPending.file] ?? {}) : {}))
          }
        />
      </div>
    </div>
  )
}
