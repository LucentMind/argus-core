import { useState } from 'react'
import type { SearchHit } from '../../../shared/types'
import { SectionLabel } from './ui'

interface Props {
  caseSlug: string | null
  onOpen: (hit: SearchHit) => void
}

function groupByCase(hits: SearchHit[], first: string | null): Array<[string, SearchHit[]]> {
  const m = new Map<string, SearchHit[]>()
  for (const h of hits) {
    const g = m.get(h.caseSlug) ?? []
    g.push(h)
    m.set(h.caseSlug, g)
  }
  return [...m.entries()].sort(([a], [b]) =>
    a === first ? -1 : b === first ? 1 : a.localeCompare(b)
  )
}

function hitSnippet(h: SearchHit): string {
  return h.snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/«/g, '<mark>')
    .replace(/»/g, '</mark>')
}

function HitItem({
  h,
  onOpen
}: {
  h: SearchHit
  onOpen: (hit: SearchHit) => void
}): React.JSX.Element {
  return (
    <li
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
        dangerouslySetInnerHTML={{ __html: hitSnippet(h) }}
      />
    </li>
  )
}

export function SearchBar({ caseSlug, onOpen }: Props): React.JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [scope, setScope] = useState<'case' | 'all'>('case')

  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const filters = caseSlug && scope === 'case' ? { caseSlug } : {}
    setHits(await window.argus.search.query(q, filters))
    setSearched(true)
  }

  const showGrouped = scope === 'all' && !!caseSlug

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
      {caseSlug && (
        <div className="flex gap-1" role="group" aria-label="search scope">
          {(['case', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded-r2 border px-2 py-1 text-xs transition-colors ${
                scope === s ? 'border-hair2 bg-hi text-ink' : 'border-hair text-dim hover:text-ink'
              }`}
            >
              {s === 'case' ? 'This case' : 'All cases'}
            </button>
          ))}
        </div>
      )}
      {hits.length > 0 &&
        (showGrouped ? (
          <div className="flex flex-col gap-2">
            {groupByCase(hits, caseSlug).map(([slug, groupHits]) => (
              <div key={slug} className="flex flex-col gap-1">
                <SectionLabel>{slug}</SectionLabel>
                <ul className="flex flex-col gap-1">
                  {groupHits.map((h, i) => (
                    <HitItem key={`${h.evidenceId}-${i}`} h={h} onOpen={onOpen} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {hits.map((h, i) => (
              <HitItem key={`${h.evidenceId}-${i}`} h={h} onOpen={onOpen} />
            ))}
          </ul>
        ))}
      {searched && hits.length === 0 && <p className="text-xs text-mute">No matches.</p>}
    </div>
  )
}
