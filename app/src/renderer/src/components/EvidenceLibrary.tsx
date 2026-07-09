import { useCallback, useEffect, useState } from 'react'
import type { ArtifactType, EvidenceRecord } from '../../../shared/types'
import { SectionLabel } from './ui'

const ALL_TYPES: ArtifactType[] = [
  'applog', 'binlog', 'archive-rec', 'list-json', 'bintrace', 'archive', 'screenshot', 'text', 'unknown'
]

export function EvidenceLibrary({ caseSlug }: { caseSlug: string }): React.JSX.Element {
  const [rows, setRows] = useState<EvidenceRecord[]>([])
  const [typeFilter, setTypeFilter] = useState<ArtifactType | ''>('')
  const [dragOver, setDragOver] = useState(false)

  const reload = useCallback(async () => {
    setRows(await window.argus.evidence.list(caseSlug))
  }, [caseSlug])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.argus.pathForFile(f))
    if (paths.length === 0) return
    await window.argus.evidence.ingest(caseSlug, paths)
    await reload()
  }

  const visible = typeFilter ? rows.filter((r) => r.artifactType === typeFilter) : rows

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
          {visible.map((r) => (
            <tr key={r.id} className="border-t border-hair">
              <td className="py-1 font-mono text-dim">{r.relPath}</td>
              <td>
                <span className="rounded-r1 bg-overlay px-1.5 py-0.5 font-mono text-dim">
                  {r.artifactType}
                </span>
              </td>
              <td className="text-dim">{r.size.toLocaleString()} B</td>
              <td className="text-dim">{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
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
