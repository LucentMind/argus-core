import { useCallback, useEffect, useState } from 'react'
import { Chip, SectionLabel } from './ui'
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
              {/* uppercase so option labels never collide with the lowercase type badges in the table */}
              {t.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="font-mono text-[10.5px] uppercase tracking-wide text-mute">
            <th className="py-1 font-medium">file</th>
            <th className="font-medium">type</th>
            <th className="font-medium">size</th>
            <th className="font-medium">added</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const skill = ANALYZE_SKILLS[r.artifactType]
            return (
              <tr key={r.id} className="border-t border-hair">
                <td className={`py-1 font-mono text-dim ${r.derived ? 'pl-6' : ''}`}>
                  {r.relPath}
                  {r.derived && (
                    <span className="ml-2">
                      <Chip tone="neutral">derived</Chip>
                    </span>
                  )}
                </td>
                <td>
                  <span className="rounded-r1 bg-overlay px-1.5 py-0.5 font-mono text-dim">
                    {r.artifactType}
                  </span>
                </td>
                <td className="text-dim">{r.size.toLocaleString()} B</td>
                <td className="text-dim">
                  {new Date(r.createdAt).toLocaleString()}
                  {skill && onSuggest && (
                    <button
                      className="ml-2 rounded-r1 border border-hair px-1.5 py-0.5 text-[11px] text-dim transition-colors hover:bg-overlay hover:text-ink"
                      onClick={() => onSuggest(`/${skill} ${r.relPath}`)}
                    >
                      Analyze
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-mute">
                No evidence yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
