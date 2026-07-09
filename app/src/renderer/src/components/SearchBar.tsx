import { useState } from 'react'
import type { SearchHit } from '../../../shared/types'

interface Props {
  caseSlug: string | null
  onOpen: (hit: SearchHit) => void
}

export function SearchBar({ caseSlug, onOpen }: Props): React.JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)

  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const filters = caseSlug ? { caseSlug } : {}
    setHits(await window.argus.search.query(q, filters))
    setSearched(true)
  }

  return (
    <div className="flex flex-col gap-2">
      <form role="search" onSubmit={(e) => void run(e)}>
        <input
          className="w-full rounded border border-neutral-600 bg-transparent px-3 py-1.5 text-sm"
          placeholder="Search evidence…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>
      {hits.length > 0 && (
        <ul className="flex flex-col gap-1">
          {hits.map((h, i) => (
            <li
              key={`${h.evidenceId}-${i}`}
              onClick={() => onOpen(h)}
              className="cursor-pointer rounded border border-neutral-800 p-2 text-xs hover:bg-neutral-800"
            >
              <div className="font-medium">
                {h.caseSlug} / {h.relPath}{' '}
                <span className="text-neutral-500">
                  ({h.artifactType}, lines {h.startLine}–{h.endLine})
                </span>
              </div>
              <div
                className="text-neutral-300"
                dangerouslySetInnerHTML={{
                  __html: h.snippet
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/«/g, '<mark>')
                    .replace(/»/g, '</mark>')
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {searched && hits.length === 0 && <p className="text-xs text-neutral-500">No matches.</p>}
    </div>
  )
}
