import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import { Chip, MenuButton, SectionLabel } from './ui'
import { confirm } from '../lib/confirmStore'
import { displayName, formatMb } from '../lib/evidenceDisplay'
import { chipStamp } from '../lib/time'
import {
  isPackClaimedType,
  type ArtifactType,
  type ArtifactTypeMeta,
  type EvidenceRecord,
  type FileNode
} from '../../../shared/types'
import { panelHandlesType, type PanelDecl } from '../../../shared/panels'
import { MAX_WHOLE_FILE_BYTES } from '../../../shared/textdoc'
import type { ModeId } from '../../../shared/modes'

const TEXT_LIKE = /\.(md|txt|log|json|jsonl|yaml|yml|csv)$/i

// Non-text evidence a default OS app renders usefully — clicking these opens
// them externally. Everything else non-text (archives, trace containers like
// .dlt that were parsed into derived text) reveals in the file explorer
// instead: handing the raw container to whatever program owns its extension
// either shows nothing useful or pops an unwanted handler.
const MEDIA_LIKE =
  /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?|mp4|mov|webm|mkv|avi|m4v|wmv|mp3|wav|m4a|ogg|pdf)$/i

function opensExternally(name: string, artifactType: ArtifactType): boolean {
  // A pack-claimed type is a domain artifact with its own extractor, whatever it
  // is named — same gate the zip auto-extraction uses, so `esotrace.zip` and a
  // pack's `.mp4`-named trace both stay out of the OS handler.
  if (isPackClaimedType(artifactType)) return false
  // 'screenshot' comes from magic-byte detection, so an image with a missing or
  // odd extension still opens in the viewer rather than the explorer
  return MEDIA_LIKE.test(name) || artifactType === 'screenshot'
}

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
  label,
  mode,
  onSuggest,
  onOpenFile,
  panelDecls = [],
  onOpenInPanel
}: {
  caseSlug: string
  /** The section title this card renders in its own header — the rail no longer renders one
   *  above it, so every section's controls sit in exactly one place. */
  label: string
  /** Which mode's material this list shows. Investigation evidence and review artifacts
   *  live in separate directories and are never mixed. */
  mode: ModeId
  onSuggest?: (text: string) => void
  onOpenFile: (node: FileNode) => void
  panelDecls?: PanelDecl[]
  onOpenInPanel?: (evidenceId: number, packId: string, windowId: string) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<EvidenceRecord[]>([])
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
      window.argus.evidence.list(caseSlug, mode).then(setRows, (err) => {
        console.warn(`[evidence] list failed for ${caseSlug}: ${(err as Error).message}`)
        setRows([])
      }),
    [caseSlug, mode]
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
  }, [reload, caseSlug, mode])

  async function scan(): Promise<void> {
    setScanning(true)
    setScanNote(null)
    try {
      const s = await window.argus.evidence.scan(caseSlug, mode)
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
    } else if (opensExternally(name, r.artifactType)) {
      void window.argus.files.open(caseSlug, r.relPath)
    } else {
      void window.argus.files.reveal(caseSlug, r.relPath)
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
    if (
      !(await confirm({
        title: `Delete "${displayName(r.relPath)}"${extra}?`,
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true
      }))
    )
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

  const visible = orderWithDerived(rows)

  function renderRow(r: EvidenceRecord & { derived?: boolean }): React.JSX.Element {
    const skill = artifactMeta.find((m) => m.type === r.artifactType)?.analyzeSkill
    const isParsing = parsing.has(r.id)
    const targets = panelHandlesType(panelDecls, r.artifactType)
    const name = displayName(r.relPath)
    return (
      // `first:border-t-0`: the rule separates rows from each other, so the top one has nothing
      // above it to separate from — it read as a stray line under the card's own edge.
      <li
        key={r.id}
        className="group flex flex-col gap-1 border-t border-hair py-2 first:border-t-0"
      >
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
              // oversized text evidence: a webPanel would whole-read the file, so
              // offer the size-routed built-in viewer instead (same auto-routing
              // as clicking the file name — >2MiB lands in the indexed viewer)
              if (r.size > MAX_WHOLE_FILE_BYTES && TEXT_LIKE.test(name)) {
                return (
                  <button
                    className="shrink-0 rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim opacity-0 transition-all hover:bg-overlay hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => clickFile(r)}
                  >
                    Open in viewer
                  </button>
                )
              }
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
    <section className="flex min-h-32 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionLabel>{label}</SectionLabel>
        <span className="h-px flex-1 bg-hair" />
        {scanNote && (
          <span className="max-w-36 shrink truncate text-[10.5px] text-mute" title={scanNote}>
            {scanNote}
          </span>
        )}
        <button
          aria-label="Rescan evidence folder"
          title={scanNote ? `Rescan — last run: ${scanNote}` : 'Rescan evidence folder'}
          disabled={scanning}
          className="relative inline-flex h-6 w-6 items-center justify-center rounded-r1 text-dim transition-colors hover:bg-hair hover:text-ink"
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
          className="inline-flex h-6 w-6 items-center justify-center rounded-r1 text-dim transition-colors hover:bg-hair hover:text-ink"
          onClick={() => void window.argus.files.reveal(caseSlug)}
        >
          <FolderOpen size={14} strokeWidth={1.5} />
        </button>
      </div>
      {deleteError && <p className="text-xs text-danger">{deleteError}</p>}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void handleDrop(e)}
        className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-r3 border bg-panel transition-colors ${
          dragOver ? 'border-signal/60 bg-signal/10' : 'border-hair'
        }`}
      >
        <ul className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
          {visible.map(renderRow)}
          {visible.length === 0 && <li className="py-2 text-mute">No evidence yet.</li>}
        </ul>
        <div
          className={`flex h-6 shrink-0 items-center justify-center border-t border-dashed text-[10px] transition-colors ${
            dragOver ? 'border-signal/60 text-signal' : 'border-hair text-mute'
          }`}
        >
          drop files to add evidence
        </div>
      </div>
    </section>
  )
}
