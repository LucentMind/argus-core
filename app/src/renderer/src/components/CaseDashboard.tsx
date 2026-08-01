import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CaseRecord, CaseStatus } from '../../../shared/types'
import { Btn, Checkbox, MenuButton, SectionLabel, type MenuItem } from './ui'
import { FolderInput, Plus, RefreshCw, Search } from 'lucide-react'
import { CaseCard } from './CaseCard'
import { DeleteCaseDialog } from './DeleteCaseDialog'
import { useSettingsPayload } from '../lib/settingsStore'
import { usePrStatuses } from '../lib/prStatusStore'
import { uiStore } from '../lib/uiStore'
import { useAmbientAnchors } from '../lib/ambientAnchors'
import { useGlassPointer } from '../lib/useGlassPointer'
import { greetingFor } from '../lib/greeting'
import { githubLogin } from '../lib/githubIdentity'
import { STATUS_ORDER, STATUS_WORD } from '../lib/caseStatus'
import { StatusDot } from './StatusDot'

export function CaseDashboard({
  cases,
  onOpen,
  onNew,
  onImport,
  onDeleted
}: {
  cases: CaseRecord[]
  onOpen: (slug: string) => void
  onNew: () => void
  onImport: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [exportNote, setExportNote] = useState<{ slug: string; text: string } | null>(null)
  const [deleteError, setDeleteError] = useState<{ slug: string; text: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pendingKnowledge, setPendingKnowledge] = useState(0)
  const [login, setLogin] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'all'>('all')
  const [priorityFilter, setPriorityFilter] = useState<string>('all')
  const [syncing, setSyncing] = useState<{ done: number; total: number } | null>(null)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const settings = useSettingsPayload()
  const ui = useSyncExternalStore(
    (cb) => uiStore.subscribe(cb),
    () => uiStore.get()
  )
  const dynamic = ui.dynamicTheme
  const anchors = useAmbientAnchors()
  const gridRef = useRef<HTMLDivElement | null>(null)
  useGlassPointer(gridRef, dynamic)

  useEffect(() => {
    let mounted = true
    window.argus.proposals
      .list()
      .then((p) => {
        if (mounted) setPendingKnowledge(p.proposals.length)
      })
      .catch(() => undefined)
    return () => {
      mounted = false
    }
  }, [])

  // Cached in githubIdentity for the renderer's lifetime, so remounting home on every return
  // from a case doesn't re-spawn gh. Resolves null (never rejects) when gh is absent or logged
  // out, which renders the bare greeting.
  useEffect(() => {
    let mounted = true
    void githubLogin().then((l) => {
      if (mounted) setLogin(l)
    })
    return () => {
      mounted = false
    }
  }, [])

  // Progress arrives on a broadcast channel while the result arrives on the
  // invoke reply; their order is NOT guaranteed. Observed live: the final
  // `3/3` event landed after the run resolved and re-disabled the button
  // permanently, with the result line already on screen. A ref (not state)
  // because the listener is registered once and would otherwise close over a
  // stale `syncing`.
  const syncActive = useRef(false)

  useEffect(
    () =>
      window.argus.jira.onSyncProgress((p) => {
        if (syncActive.current) setSyncing(p)
      }),
    []
  )

  async function syncAll(): Promise<void> {
    setSyncNote(null)
    syncActive.current = true
    setSyncing({ done: 0, total: 0 })
    try {
      const r = await window.argus.jira.syncAll()
      setSyncNote(
        r.ok
          ? `${r.value.synced} synced · ${r.value.changed} changed · ${r.value.failed} failed`
          : r.message
      )
    } finally {
      // clear the gate BEFORE the state reset, so a progress event racing this
      // block can never win and leave the button stuck
      syncActive.current = false
      setSyncing(null)
      onDeleted() // reuse the existing list-reload callback
    }
  }

  async function exportCase(slug: string): Promise<void> {
    setExportNote(null)
    const r = await window.argus.bundle.export(slug, true)
    if (!r) return // save dialog canceled
    setExportNote({ slug, text: r.ok ? `exported ${r.fileCount} files` : r.error })
  }

  async function requestDelete(slug: string): Promise<void> {
    // default true — also while the settings payload is still loading
    const confirm = settings?.settings.general.confirmCaseDelete ?? true
    if (!confirm) {
      setDeleteError(null)
      try {
        await window.argus.cases.delete(slug)
      } catch (err) {
        setDeleteError({ slug, text: (err as Error).message })
      } finally {
        // resync the list even on failure — the deletion may have partially committed
        onDeleted()
      }
      return
    }
    setDeleting(slug)
  }

  /** 60s, not review mode's 20s: many PRs, none of them being stared at. Still polls only while
   *  some check is running, and only while the dashboard is mounted. The FULL case list is
   *  passed, not `visible` — a filtered-out case should keep refreshing so its dot is right the
   *  moment the filter clears. */
  const prStatuses = usePrStatuses(
    cases.map((c) => c.slug),
    60_000
  )

  const q = filter.trim().toLowerCase()
  const visible = cases.filter((c) => {
    // An explicit Closed filter is a stronger statement of intent than the standing
    // hide-closed default, so it wins.
    if (!showClosed && statusFilter !== 'closed' && c.status === 'closed') return false
    if (statusFilter !== 'all' && c.status !== statusFilter) return false
    if (priorityFilter !== 'all' && c.jiraPriority !== priorityFilter) return false
    if (!q) return true
    return (
      c.slug.toLowerCase().includes(q) ||
      c.title.toLowerCase().includes(q) ||
      (c.jiraKey?.toLowerCase().includes(q) ?? false)
    )
  })
  const counts = cases.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1
    return acc
  }, {})
  const countLabel = STATUS_ORDER.filter((s) => counts[s])
    .map((s) => `${counts[s]} ${STATUS_WORD[s]}`)
    .join(' · ')

  const STATUS_MENU: { id: CaseStatus; label: string }[] = STATUS_ORDER.map((id) => ({
    id,
    label: STATUS_WORD[id]
  }))
  const statusItems: MenuItem[] = [
    { label: 'All statuses', onSelect: () => setStatusFilter('all') },
    ...STATUS_MENU.map((s) => ({ label: s.label, onSelect: () => setStatusFilter(s.id) }))
  ]
  // Derived, not hardcoded: the priority scheme is per-Jira-project, so the menu offers exactly
  // the values on screen and nothing else.
  const priorities = [...new Set(cases.map((c) => c.jiraPriority).filter((p): p is string => !!p))]
  const priorityItems: MenuItem[] = [
    { label: 'All priorities', onSelect: () => setPriorityFilter('all') },
    ...priorities.map((p) => ({ label: p, onSelect: () => setPriorityFilter(p) }))
  ]
  const statusTrigger =
    statusFilter === 'all'
      ? 'Status'
      : `Status: ${STATUS_MENU.find((s) => s.id === statusFilter)?.label ?? statusFilter}`

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-8">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2.5">
            {/* Still the ambient light source (the aurora anchors to this rect), but no longer
                the wordmark — that moved to the top bar. Sans, not the brand face: Michroma at
                letterSpacing 11 is built for five letters, not a sentence. */}
            {/* `font-light` is weight 300 and it only became real when main.tsx/editor.tsx started
                importing @fontsource/geist-sans/300.css. Before that only 400/500/600 were loaded,
                300 had no matching face, and CSS font matching fell back to 400 — browsers
                synthesise bolder, never lighter, so the masthead silently rendered at the same
                weight as everything else. Removing the 300 import re-breaks this line, quietly. */}
            <h1 ref={anchors.setLight} className="text-[30px] font-light leading-[1.2] text-ink">
              {greetingFor(new Date())}
              {login ? `, ${login}` : ''}
            </h1>
            {pendingKnowledge > 0 && (
              <p className="flex items-center gap-2 text-xs text-dim">
                Knowledge review pending: {pendingKnowledge}
                <StatusDot color="text-defect" size={6} />
              </p>
            )}
            {/* The counterpart to the --mute note in theme-dynamic.css: under .dyn this label sits
                on the OPAQUE hot core of the ambient canvas (~rgb(60,120,168), L≈0.149), and no
                value of --mute clears 4.5:1 there — that needs L≥0.845, i.e. near-white, which is
                not a mute any more. The token lift helps everywhere else; making THIS line legible
                means moving it off the light or pulling the light's cutoff above it, which is a
                design decision, not a token one. */}
            <SectionLabel>Cases · {countLabel || '0 total'}</SectionLabel>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Btn
              variant="primary"
              className={`h-9 px-4 text-sm${dynamic ? ' dyn-btn-primary' : ''}`}
              onClick={onNew}
            >
              <Plus size={16} aria-hidden="true" /> New case
            </Btn>
            <Btn variant="outline" className="h-9 px-4 text-sm" onClick={onImport}>
              <FolderInput size={16} aria-hidden="true" /> Import case…
            </Btn>
          </div>
        </div>
        {/* anchors.setLight/setCutoff are useState setters used directly as ref
            callbacks (the React-documented way to observe a DOM node) — not a
            stale `.current` read, so the compiler's react-hooks/refs heuristic
            here is a false positive. */}
        {/* eslint-disable-next-line react-hooks/refs */}
        <div ref={anchors.setCutoff} className="flex flex-wrap items-center gap-2">
          {/* The input is sized DOWN to the buttons rather than the buttons up to it: `Btn`'s
              h-7 comes from BTN_BASE, and a height class appended at the call site is resolved
              by Tailwind's emission order, not attribute order — see IconBtn's note in ui.tsx.
              Matching the primitive costs nothing and can't silently stop working. */}
          <div className="relative">
            <Search
              size={13}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute"
            />
            <input
              className="h-7 w-56 rounded-r2 border border-hair2 bg-overlay pl-7 pr-2.5 text-xs text-ink placeholder:text-mute transition-colors focus:border-faint"
              placeholder="Search cases…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <MenuButton label={statusTrigger} items={statusItems} variant="outline" align="left" />
          <MenuButton
            label={priorityFilter === 'all' ? 'Priority' : `Priority: ${priorityFilter}`}
            items={priorityItems}
            variant="outline"
            align="left"
          />
          {/* Left of the ml-auto on purpose: the note appears only after a sync finishes, and
              inside the right-hand group it would shove Sync all and Show closed sideways. */}
          {syncNote && <span className="text-xs text-dim">{syncNote}</span>}
          <div className="ml-auto flex items-center gap-3">
            <Btn onClick={() => void syncAll()} disabled={syncing !== null}>
              <RefreshCw size={13} aria-hidden="true" />
              {syncing ? `syncing ${syncing.done}/${syncing.total}…` : 'Sync all'}
            </Btn>
            <Checkbox
              checked={showClosed}
              onChange={setShowClosed}
              aria-label="Show closed cases"
              label="Show closed"
            />
          </div>
        </div>
      </div>
      <div ref={gridRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((c, i) => (
          <CaseCard
            key={c.slug}
            c={c}
            dynamic={dynamic}
            index={i}
            onOpen={onOpen}
            onExport={(slug) => void exportCase(slug)}
            onDelete={(slug) => void requestDelete(slug)}
            prRollup={prStatuses[c.slug]?.rollup}
            note={
              deleteError?.slug === c.slug
                ? { text: deleteError.text, danger: true }
                : exportNote?.slug === c.slug
                  ? { text: exportNote.text, danger: false }
                  : null
            }
          />
        ))}
      </div>
      {deleting && (
        <DeleteCaseDialog
          slug={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            onDeleted()
          }}
        />
      )}
    </div>
  )
}
