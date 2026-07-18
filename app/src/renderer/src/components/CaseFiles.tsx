import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import { Chip, MenuButton, SectionLabel } from './ui'
import { displayName, formatMb } from '../lib/evidenceDisplay'
import { chipStamp } from '../lib/time'
import type {
  ArtifactType,
  ArtifactTypeMeta,
  EvidenceRecord,
  FileNode
} from '../../../shared/types'
import { panelHandlesType, type PanelDecl } from '../../../shared/panels'

const TEXT_LIKE = /\.(md|txt|log|json|jsonl|yaml|yml|csv)$/i

// derived rows (meta.derivedFrom) sort directly below their source row
function orderWithDerived(rows: EvidenceRecord[]): (EvidenceRecord & { derived?: boolean })[] {
  const derivedBySource = new Map<number, EvidenceRecord[]>()
  const top: EvidenceRecord[] = []
  for (const r of rows) {
    const from = r.meta.derivedFrom
    if (typeof from === 'number') {
      const list = derivedBySource.get(from) ?? []
      list.push(r)
      derivedBySource.set(from, list)
    } else {
      top.push(r)
    }
  }
  const ordered: (EvidenceRecord & { derived?: boolean })[] = []
  for (const r of top) {
    ordered.push(r)
    for (const d of derivedBySource.get(r.id) ?? []) ordered.push({ ...d, derived: true })
    derivedBySource.delete(r.id)
  }
  // orphans whose source is filtered out or gone still render (unindented source position)
  for (const list of derivedBySource.values()) {
    for (const d of list) ordered.push({ ...d, derived: true })
  }
  return ordered
}

export function CaseFiles({
  caseSlug,
  onSuggest,
  onOpenFile,
  panelDecls = [],
  onOpenInPanel
}: {
  caseSlug: string
  onSuggest?: (text: string) => void
  onOpenFile: (node: FileNode) => void
  panelDecls?: PanelDecl[]
  onOpenInPanel?: (evidenceId: number, packId: string, windowId: string) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<EvidenceRecord[]>([])
  const [typeFilter, setTypeFilter] = useState<ArtifactType | ''>('')
  const [parsing, setParsing] = useState<Set<number>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const [artifactMeta, setArtifactMeta] = useState<ArtifactTypeMeta[]>([])
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    void window.argus.packs.artifactMeta().then(setArtifactMeta, (err) => {
      console.warn(`[packs] artifactMeta failed: ${(err as Error).message}`)
      setArtifactMeta([])
    })
  }, [])

  const reload = useCallback(
    (): Promise<void> =>
      window.argus.evidence.list(caseSlug).then(setRows, (err) => {
        console.warn(`[evidence] list failed for ${caseSlug}: ${(err as Error).message}`)
        setRows([])
      }),
    [caseSlug]
  )

  useEffect(() => {
    void reload()
    const offEvidence = window.argus.evidence.onChanged?.((slug) => {
      if (slug === caseSlug) void reload()
    })
    const offParsing = window.argus.evidence.onParsing((p) => {
      if (p.slug !== caseSlug) return
      setParsing((prev) => {
        const next = new Set(prev)
        if (p.active) next.add(p.evidenceId)
        else next.delete(p.evidenceId)
        return next
      })
    })
    const offFiles = window.argus.files.onChanged((slug) => {
      if (slug === caseSlug) setStale(true)
    })
    return () => {
      offEvidence?.()
      offParsing?.()
      offFiles()
    }
  }, [reload, caseSlug])

  async function scan(): Promise<void> {
    setScanning(true)
    setScanNote(null)
    try {
      const s = await window.argus.evidence.scan(caseSlug)
      const parts: string[] = []
      if (s.added.length) parts.push(`${s.added.length} added`)
      if (s.modified.length) parts.push(`${s.modified.length} updated`)
      if (s.missing.length) parts.push(`${s.missing.length} missing`)
      if (s.errors.length) parts.push(`${s.errors.length} failed`)
      setScanNote(parts.join(' · ') || 'no changes')
      setStale(false)
      await reload()
    } catch (err) {
      setScanNote(`scan failed: ${(err as Error).message}`)
    } finally {
      setScanning(false)
    }
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.argus.pathForFile(f))
    if (paths.length === 0) return
    await window.argus.evidence.ingest(caseSlug, paths)
    await reload()
  }

  function clickFile(r: EvidenceRecord): void {
    const name = r.relPath.split('/').pop() ?? r.relPath
    if (TEXT_LIKE.test(name)) {
      onOpenFile({
        name,
        relPath: r.relPath,
        kind: 'file',
        size: r.size,
        evidence: {
          id: r.id,
          artifactType: r.artifactType,
          derived: typeof r.meta.derivedFrom === 'number'
        }
      })
    } else {
      void window.argus.files.open(caseSlug, r.relPath)
    }
  }

  async function deleteEvidenceFile(r: EvidenceRecord): Promise<void> {
    const id = r.id
    // count the derived closure client-side so the confirm names what goes with it
    // (use the already-loaded rows rather than re-fetching)
    const doomed = new Set([id])
    for (let grew = true; grew;) {
      grew = false
      for (const row of rows) {
        const parent = row.meta.derivedFrom
        if (!doomed.has(row.id) && typeof parent === 'number' && doomed.has(parent)) {
          doomed.add(row.id)
          grew = true
        }
      }
    }
    const derived = doomed.size - 1
    const extra = derived > 0 ? ` and ${derived} derived file${derived > 1 ? 's' : ''}` : ''
    if (!window.confirm(`Delete "${displayName(r.relPath)}"${extra}? This cannot be undone.`))
      return
    setDeleteError(null)
    try {
      await window.argus.evidence.delete(caseSlug, id)
    } catch (err) {
      setDeleteError((err as Error).message)
    } finally {
      // a post-commit filesystem failure still needs the list resynced — the DB row is gone either way
      await reload()
    }
  }

  const visible = orderWithDerived(
    typeFilter ? rows.filter((r) => r.artifactType === typeFilter) : rows
  )

  function renderRow(r: EvidenceRecord & { derived?: boolean }): React.JSX.Element {
    const skill = artifactMeta.find((m) => m.type === r.artifactType)?.analyzeSkill
    const isParsing = parsing.has(r.id)
    const targets = panelHandlesType(panelDecls, r.artifactType)
    const name = displayName(r.relPath)
    return (
      <li key={r.id} className="group flex flex-col gap-1 border-t border-hair py-2">
        <div className="flex items-center gap-2">
          <button
            className="max-w-[220px] min-w-0 truncate text-left font-mono text-xs text-dim hover:text-ink"
            title={name}
            onClick={() => clickFile(r)}
          >
            {name}
          </button>
          {r.derived && <Chip tone="neutral">derived</Chip>}
          {r.meta.missing === true && <Chip tone="danger">missing</Chip>}
          <span className="ml-auto line-clamp-2 max-w-[70px] shrink-0 whitespace-normal rounded-r1 bg-overlay px-1.5 py-0.5 text-center font-mono text-[10px] leading-tight text-dim">
            {r.artifactType}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-mute">
          <span>{formatMb(r.size)}</span>
          <span>{chipStamp(r.createdAt)}</span>
          {isParsing && (
            <span className="flex items-center gap-1 text-signal">
              <span className="h-2 w-2 animate-spin rounded-full border border-signal border-t-transparent" />
              parsing…
            </span>
          )}
        </div>
        <div className="flex h-6 items-center justify-end gap-1.5">
          {skill && onSuggest && (
            <button
              className="shrink-0 rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim opacity-0 transition-all hover:bg-overlay hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => onSuggest(`/${skill} ${r.relPath}`)}
            >
              Analyze
            </button>
          )}
          {onOpenInPanel &&
            (() => {
              if (targets.length === 0) return null
              if (targets.length === 1) {
                const t = targets[0]
                return (
                  <button
                    className="shrink-0 rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim opacity-0 transition-all hover:bg-overlay hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => onOpenInPanel(r.id, t.packId, t.windowId)}
                  >
                    Open in {t.title}
                  </button>
                )
              }
              return (
                <div className="shrink-0">
                  <MenuButton
                    label="Open in"
                    align="right"
                    items={targets.map((t) => ({
                      label: t.title,
                      onSelect: () => onOpenInPanel(r.id, t.packId, t.windowId)
                    }))}
                  />
                </div>
              )
            })()}
          <button
            aria-label={`Delete ${name}`}
            title="Delete evidence"
            className="shrink-0 rounded-r1 border border-hair p-1 text-dim opacity-0 transition-all hover:bg-overlay hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => void deleteEvidenceFile(r)}
          >
            <Trash2 size={12} strokeWidth={1.5} />
          </button>
        </div>
      </li>
    )
  }

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
      className={`flex flex-col gap-2 rounded-r3 border bg-panel p-3 transition-colors ${
        dragOver ? 'border-signal/60 bg-signal/10' : 'border-hair'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Files</SectionLabel>
        <div className="flex items-center gap-1.5">
          <select
            aria-label="type-filter"
            className="rounded-r1 border border-hair bg-overlay px-1 py-0.5 text-xs text-dim"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ArtifactType | '')}
          >
            <option value="">all types</option>
            {artifactMeta.map((m) => (
              <option key={m.type} value={m.type}>
                {m.displayName}
              </option>
            ))}
          </select>
          <button
            aria-label="Rescan evidence folder"
            title="Rescan evidence folder"
            disabled={scanning}
            className="relative inline-flex h-6 w-6 items-center justify-center rounded-r1 border border-hair text-dim transition-colors hover:bg-overlay hover:text-ink"
            onClick={() => void scan()}
          >
            <RefreshCw
              size={14}
              strokeWidth={1.5}
              className={scanning ? 'animate-spin' : undefined}
            />
            {stale && (
              <span
                data-testid="files-stale-dot"
                title="Folder changed on disk — rescan to update"
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-signal"
              />
            )}
          </button>
          <button
            aria-label="Open in file explorer"
            title="Open in file explorer"
            className="inline-flex h-6 w-6 items-center justify-center rounded-r1 border border-hair text-dim transition-colors hover:bg-overlay hover:text-ink"
            onClick={() => void window.argus.files.reveal(caseSlug)}
          >
            <FolderOpen size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {deleteError && <p className="text-xs text-danger">{deleteError}</p>}
      {scanNote && <p className="text-xs text-dim">{scanNote}</p>}
      <ul className="text-xs">
        {visible.map(renderRow)}
        {visible.length === 0 && (
          <li className="border-t border-hair py-2 text-mute">No evidence yet.</li>
        )}
      </ul>
      <div className="mt-1 border-t border-dashed border-hair pt-2 text-center text-[11px] text-mute">
        Drop files here to add evidence
      </div>
    </section>
  )
}
