import { useCallback, useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Chip, SectionLabel } from './ui'
import { displayName, formatMb } from '../lib/evidenceDisplay'
import type { ArtifactType, ArtifactTypeMeta, FileNode } from '../../../shared/types'

const TEXT_LIKE = /\.(md|txt|log|json|jsonl|yaml|yml|csv)$/i

function filterTree(nodes: FileNode[], type: ArtifactType | ''): FileNode[] {
  if (!type) return nodes
  return nodes
    .map((n) => (n.kind === 'dir' ? { ...n, children: filterTree(n.children ?? [], type) } : n))
    .filter((n) =>
      n.kind === 'dir' ? (n.children?.length ?? 0) > 0 : n.evidence?.artifactType === type
    )
}

export function CaseFiles({
  caseSlug,
  onSuggest,
  onOpenFile
}: {
  caseSlug: string
  onSuggest?: (text: string) => void
  onOpenFile: (node: FileNode) => void
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>([])
  const [typeFilter, setTypeFilter] = useState<ArtifactType | ''>('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()) // default: everything expanded
  const [parsing, setParsing] = useState<Set<number>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const [artifactMeta, setArtifactMeta] = useState<ArtifactTypeMeta[]>([])

  useEffect(() => {
    void window.argus.packs.artifactMeta().then(setArtifactMeta, (err) => {
      console.warn(`[packs] artifactMeta failed: ${(err as Error).message}`)
      setArtifactMeta([])
    })
  }, [])

  const reload = useCallback(
    (): Promise<void> =>
      window.argus.files.list(caseSlug).then(setTree, (err) => {
        console.warn(`[files] list failed for ${caseSlug}: ${(err as Error).message}`)
        setTree([])
      }),
    [caseSlug]
  )

  useEffect(() => {
    void reload()
    const offFiles = window.argus.files.onChanged((slug) => {
      if (slug === caseSlug) void reload()
    })
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
    return () => {
      offFiles?.()
      offEvidence?.()
      offParsing?.()
    }
  }, [reload, caseSlug])

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.argus.pathForFile(f))
    if (paths.length === 0) return
    await window.argus.evidence.ingest(caseSlug, paths)
    await reload()
  }

  function clickFile(node: FileNode): void {
    if (TEXT_LIKE.test(node.name)) onOpenFile(node)
    else void window.argus.files.open(caseSlug, node.relPath)
  }

  function renderNodes(nodes: FileNode[], depth: number): React.JSX.Element[] {
    return nodes.flatMap((n) => {
      if (n.kind === 'dir') {
        const isCollapsed = collapsed.has(n.relPath)
        return [
          <li key={n.relPath}>
            <button
              className="flex w-full items-center gap-1 py-1 font-mono text-xs text-dim hover:text-ink"
              style={{ paddingLeft: depth * 12 }}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(n.relPath)) next.delete(n.relPath)
                  else next.add(n.relPath)
                  return next
                })
              }
            >
              <span className="text-mute">{isCollapsed ? '▸' : '▾'}</span>
              <span>{n.name}</span>/
            </button>
            {!isCollapsed && <ul>{renderNodes(n.children ?? [], depth + 1)}</ul>}
          </li>
        ]
      }
      const skill = n.evidence
        ? artifactMeta.find((m) => m.type === n.evidence?.artifactType)?.analyzeSkill
        : undefined
      const isParsing = n.evidence ? parsing.has(n.evidence.id) : false
      return [
        <li
          key={n.relPath}
          className="group flex items-center gap-2 border-t border-hair py-1.5"
          style={{ paddingLeft: depth * 12 }}
          title={n.relPath}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <button
              className="min-w-0 truncate text-left font-mono text-xs text-dim hover:text-ink"
              onClick={() => clickFile(n)}
            >
              {displayName(n.name)}
              {n.evidence?.derived && (
                <span className="ml-2">
                  <Chip tone="neutral">derived</Chip>
                </span>
              )}
            </button>
            <div className="flex items-center gap-2 text-xs text-mute">
              {n.evidence && (
                <span className="rounded-r1 bg-overlay px-1.5 py-0.5 font-mono text-dim">
                  {n.evidence.artifactType}
                </span>
              )}
              <span>{formatMb(n.size)}</span>
              {isParsing && (
                <span className="flex items-center gap-1 text-signal">
                  <span className="h-2 w-2 animate-spin rounded-full border border-signal border-t-transparent" />
                  parsing…
                </span>
              )}
            </div>
          </div>
          {skill && onSuggest && (
            <button
              className="shrink-0 rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim opacity-0 transition-all hover:bg-overlay hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => onSuggest(`/${skill} ${n.relPath}`)}
            >
              Analyze
            </button>
          )}
        </li>
      ]
    })
  }

  const visible = filterTree(tree, typeFilter)

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
            aria-label="Open in file explorer"
            title="Open in file explorer"
            className="inline-flex h-6 w-6 items-center justify-center rounded-r1 border border-hair text-dim transition-colors hover:bg-overlay hover:text-ink"
            onClick={() => void window.argus.files.reveal(caseSlug)}
          >
            <FolderOpen size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <ul className="text-xs">
        {renderNodes(visible, 0)}
        {visible.length === 0 && (
          <li className="border-t border-hair py-2 text-mute">No files yet.</li>
        )}
      </ul>
      <div className="mt-1 border-t border-dashed border-hair pt-2 text-center text-[11px] text-mute">
        Drop files here to add evidence
      </div>
    </section>
  )
}
