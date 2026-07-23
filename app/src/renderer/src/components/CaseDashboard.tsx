import { useEffect, useRef, useState } from 'react'
import type { CaseRecord } from '../../../shared/types'
import { Btn, SectionLabel } from './ui'
import { FolderInput, Plus } from 'lucide-react'
import { CaseCard } from './CaseCard'
import { DeleteCaseDialog } from './DeleteCaseDialog'
import { useSettingsPayload } from '../lib/settingsStore'

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
  const [filter, setFilter] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const [syncing, setSyncing] = useState<{ done: number; total: number } | null>(null)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const settings = useSettingsPayload()

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

  const q = filter.trim().toLowerCase()
  const visible = cases.filter((c) => {
    if (!showClosed && c.status === 'closed') return false
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
  const countLabel = (['open', 'analyzing', 'rca-drafted', 'closed'] as const)
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(' · ')

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-8">
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <SectionLabel>Cases · {countLabel || '0 total'}</SectionLabel>
            <h1
              className="font-brand font-normal leading-[1.2] text-brand"
              style={{ fontSize: 32, letterSpacing: 11 }}
            >
              ARGUS
            </h1>
            {pendingKnowledge > 0 && (
              <p className="text-xs text-dim">Knowledge review pending: {pendingKnowledge}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Btn variant="primary" className="h-9 px-4 text-sm" onClick={onNew}>
              <Plus size={16} aria-hidden="true" /> New case
            </Btn>
            <Btn variant="outline" className="h-9 px-4 text-sm" onClick={onImport}>
              <FolderInput size={16} aria-hidden="true" /> Import case…
            </Btn>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="h-8 w-56 rounded-r2 border border-hair bg-overlay px-3 text-sm text-ink placeholder:text-mute transition-colors focus:border-hair2"
            placeholder="Filter cases…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-xs text-dim">
            <input
              type="checkbox"
              aria-label="Show closed cases"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            Show closed
          </label>
          <Btn onClick={() => void syncAll()} disabled={syncing !== null}>
            {syncing ? `syncing ${syncing.done}/${syncing.total}…` : 'Sync all'}
          </Btn>
          {syncNote && <span className="text-xs text-dim">{syncNote}</span>}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((c) => (
          <CaseCard
            key={c.slug}
            c={c}
            onOpen={onOpen}
            onExport={(slug) => void exportCase(slug)}
            onDelete={(slug) => void requestDelete(slug)}
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
