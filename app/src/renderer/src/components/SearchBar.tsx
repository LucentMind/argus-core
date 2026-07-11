import { useState } from 'react'
import { FileText, MessageSquare } from 'lucide-react'
import type { SearchFilters, UnifiedHit } from '../../../shared/types'
import { SectionLabel } from './ui'

interface Props {
  caseSlug: string | null
  onOpen: (hit: UnifiedHit) => void
}

function groupByCase(hits: UnifiedHit[], first: string | null): Array<[string, UnifiedHit[]]> {
  const m = new Map<string, UnifiedHit[]>()
  for (const h of hits) {
    const g = m.get(h.caseSlug) ?? []
    g.push(h)
    m.set(h.caseSlug, g)
  }
  return [...m.entries()].sort(([a], [b]) =>
    a === first ? -1 : b === first ? 1 : a.localeCompare(b)
  )
}

function markSnippet(snippet: string): string {
  return snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/«/g, '<mark>')
    .replace(/»/g, '</mark>')
}

function hitKey(h: UnifiedHit, i: number): string {
  return h.kind === 'chat' ? `c-${h.sessionId}-${i}` : `e-${h.evidenceId}-${i}`
}

function HitItem({
  h,
  onOpen
}: {
  h: UnifiedHit
  onOpen: (hit: UnifiedHit) => void
}): React.JSX.Element {
  return (
    <li
      onClick={() => onOpen(h)}
      className="cursor-pointer rounded-r2 border border-hair bg-panel p-2 text-xs transition-colors hover:border-hair2 hover:bg-hi"
    >
      {h.kind === 'chat' ? (
        <div className="flex items-center gap-1.5 font-mono font-medium text-ink">
          <MessageSquare size={12} className="shrink-0 text-mute" aria-hidden="true" />
          <span>
            {h.caseSlug} / {h.sessionTitle || `session ${h.sessionId}`}{' '}
            <span className="text-mute">({h.role})</span>
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 font-mono font-medium text-ink">
          <FileText size={12} className="shrink-0 text-mute" aria-hidden="true" />
          <span>
            {h.caseSlug} / {h.relPath}{' '}
            <span className="text-mute">
              ({h.artifactType}, lines {h.startLine}–{h.endLine})
            </span>
          </span>
        </div>
      )}
      <div
        className="font-mono text-dim [&_mark]:bg-defect/30 [&_mark]:text-ink"
        dangerouslySetInnerHTML={{ __html: markSnippet(h.snippet) }}
      />
    </li>
  )
}

export function SearchBar({ caseSlug, onOpen }: Props): React.JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<UnifiedHit[]>([])
  const [searched, setSearched] = useState(false)
  const [scope, setScope] = useState<'case' | 'all'>('case')

  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const filters: SearchFilters = caseSlug
      ? scope === 'case'
        ? { caseSlug }
        : {}
      : { sources: ['evidence', 'chat'] }
    setHits(await window.argus.search.query(q, filters))
    setSearched(true)
  }

  // grouped whenever results can span cases: in-case "all" scope, or the dashboard
  const showGrouped = caseSlug ? scope === 'all' : true

  return (
    <div className="flex flex-col gap-2">
      <form role="search" onSubmit={(e) => void run(e)}>
        <input
          className="h-8 w-full rounded-r2 border border-hair bg-overlay px-3 text-sm text-ink placeholder:text-mute transition-colors focus:border-hair2"
          placeholder={caseSlug ? 'Search evidence…' : 'Search evidence & chats…'}
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
                    <HitItem key={hitKey(h, i)} h={h} onOpen={onOpen} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {hits.map((h, i) => (
              <HitItem key={hitKey(h, i)} h={h} onOpen={onOpen} />
            ))}
          </ul>
        ))}
      {searched && hits.length === 0 && <p className="text-xs text-mute">No matches.</p>}
    </div>
  )
}
