import { useCallback, useEffect, useState } from 'react'
import type { ArtifactType, EvidenceRecord } from '../../../shared/types'

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
      className={`flex flex-col gap-2 rounded border p-3 ${
        dragOver ? 'border-blue-400 bg-blue-950/30' : 'border-neutral-700'
      }`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Evidence — drop files here</h2>
        <select
          aria-label="type-filter"
          className="rounded border border-neutral-600 bg-neutral-900 px-1 py-0.5 text-xs"
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
        <thead className="text-neutral-400">
          <tr>
            <th className="py-1">file</th>
            <th>type</th>
            <th>size</th>
            <th>added</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.id} className="border-t border-neutral-800">
              <td className="py-1">{r.relPath}</td>
              <td>
                <span className="rounded bg-neutral-700 px-1.5 py-0.5">{r.artifactType}</span>
              </td>
              <td>{r.size.toLocaleString()} B</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-neutral-500">
                No evidence yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}
