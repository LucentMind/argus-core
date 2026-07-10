import { useCallback, useEffect, useState } from 'react'
import { Chip, SectionLabel } from './ui'
import { displayName, formatMb } from '../lib/evidenceDisplay'
import type { ArtifactType, EvidenceRecord } from '../../../shared/types'

const ALL_TYPES: ArtifactType[] = [
  'applog',
  'binlog',
  'archive-rec',
  'list-json',
  'tagged-json',
  'bintrace',
  'archive',
  'screenshot',
  'text',
  'unknown'
]

// binary/log types → the skill the Analyze button suggests in the composer
const ANALYZE_SKILLS: Partial<Record<ArtifactType, string>> = {
  binlog: 'analyze-binlog',
  'archive-rec': 'analyze-archive-rec',
  'tagged-json': 'analyze-tagged-json',
  applog: 'analyze-applog'
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

export function EvidenceLibrary({
  caseSlug,
  onSuggest
}: {
  caseSlug: string
  onSuggest?: (text: string) => void
}): React.JSX.Element {
  const [rows, setRows] = useState<EvidenceRecord[]>([])
  const [typeFilter, setTypeFilter] = useState<ArtifactType | ''>('')
  const [dragOver, setDragOver] = useState(false)

  const reload = useCallback(
    (): Promise<void> => window.argus.evidence.list(caseSlug).then(setRows),
    [caseSlug]
  )

  useEffect(() => {
    void reload()
    // reload when background extraction registers derived text
    return window.argus.evidence.onChanged?.((slug) => {
      if (slug === caseSlug) void reload()
    })
  }, [reload, caseSlug])

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.argus.pathForFile(f))
    if (paths.length === 0) return
    await window.argus.evidence.ingest(caseSlug, paths)
    await reload()
  }

  const visible = orderWithDerived(
    typeFilter ? rows.filter((r) => r.artifactType === typeFilter) : rows
  )

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
        <SectionLabel>Evidence — drop files here</SectionLabel>
        <select
          aria-label="type-filter"
          className="rounded-r1 border border-hair bg-overlay px-1 py-0.5 text-xs text-dim"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as ArtifactType | '')}
        >
          <option value="">all types</option>
          {ALL_TYPES.map((t) => (
            <option key={t} value={t}>
              {/* uppercase so option labels never collide with the lowercase type badges in the list */}
              {t.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <ul className="text-xs">
        {visible.map((r) => {
          const skill = ANALYZE_SKILLS[r.artifactType]
          return (
            <li
              key={r.id}
              className={`group flex items-center gap-2 border-t border-hair py-1.5 ${
                r.derived ? 'pl-6' : ''
              }`}
              title={r.relPath}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-dim">
                    {displayName(r.relPath)}
                  </span>
                  {r.derived && (
                    <span className="flex-shrink-0">
                      <Chip tone="neutral">derived</Chip>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-mute">
                  <span className="rounded-r1 bg-overlay px-1.5 py-0.5 font-mono text-dim">
                    {r.artifactType}
                  </span>
                  <span>{formatMb(r.size)}</span>
                </div>
              </div>
              {skill && onSuggest && (
                <button
                  className="shrink-0 rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim opacity-0 transition-all hover:bg-overlay hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => onSuggest(`/${skill} ${r.relPath}`)}
                >
                  Analyze
                </button>
              )}
            </li>
          )
        })}
        {visible.length === 0 && (
          <li className="border-t border-hair py-2 text-mute">No evidence yet.</li>
        )}
      </ul>
    </section>
  )
}
