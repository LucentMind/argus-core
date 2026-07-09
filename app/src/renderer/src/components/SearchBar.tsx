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
          className="h-8 w-full rounded-r2 border border-hair bg-overlay px-3 text-sm text-ink placeholder:text-mute transition-colors focus:border-hair2"
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
              className="cursor-pointer rounded-r2 border border-hair bg-panel p-2 text-xs transition-colors hover:border-hair2 hover:bg-hi"
            >
              <div className="font-mono font-medium text-ink">
                {h.caseSlug} / {h.relPath}{' '}
                <span className="text-mute">
                  ({h.artifactType}, lines {h.startLine}–{h.endLine})
                </span>
              </div>
              <div
                className="font-mono text-dim [&_mark]:bg-defect/30 [&_mark]:text-ink"
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
      {searched && hits.length === 0 && <p className="text-xs text-mute">No matches.</p>}
    </div>
  )
}
