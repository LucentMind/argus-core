import { useState } from 'react'
import { FileText, MessageSquare, BookMarked } from 'lucide-react'
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
  if (h.kind === 'chat') return `c-${h.sessionId}-${i}`
  if (h.kind === 'summary') return `s-${h.caseSlug}-${i}`
  return `e-${h.evidenceId}-${i}`
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
      className="cursor-pointer rounded-r2 surface-card p-2 text-xs transition-colors hover:border-hair2 hover:bg-hi"
    >
      {h.kind === 'chat' ? (
        <div className="flex items-center gap-1.5 font-mono font-medium text-ink">
          <MessageSquare size={12} className="shrink-0 text-mute" aria-hidden="true" />
          <span>
            {h.caseSlug} / {h.sessionTitle || `session ${h.sessionId}`}{' '}
            <span className="text-mute">({h.role})</span>
          </span>
        </div>
      ) : h.kind === 'summary' ? (
        <div className="flex items-center gap-1.5 font-mono font-medium text-ink">
          <BookMarked size={12} className="shrink-0 text-mute" aria-hidden="true" />
          <span>
            {h.caseSlug} / {h.signature} <span className="text-mute">(closed case)</span>
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

  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    // Investigation-only surface: CaseWorkspace renders SearchBar only when
    // activeMode !== 'review'. Stated explicitly rather than relying on the
    // searchEvidence default, so a future review search UI has one place to change.
    const base: SearchFilters = { evidenceScope: 'investigation' }
    // No scope switch any more (user-directed, 2026-08-02). The field now sits under the
    // Evidence header, inside the card whose contents it filters, so "this case" is what the
    // control's own placement asserts — a pair of scope buttons under it both contradicted that
    // placement and made a two-line control out of a one-line one. Cross-case search still
    // exists: it is the dashboard's field (caseSlug === null), which searches chats too.
    const filters: SearchFilters = caseSlug
      ? { ...base, caseSlug }
      : { ...base, sources: ['evidence', 'chat', 'summaries'] }
    setHits(await window.argus.search.query(q, filters))
    setSearched(true)
  }

  // grouped only where results can span cases, i.e. the dashboard
  const showGrouped = caseSlug === null

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
          // Capped and scrollable: in the case view this list now renders between the Evidence
          // header and the evidence card, so an uncapped result set would push the card it
          // belongs to off the bottom of the rail.
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {hits.map((h, i) => (
              <HitItem key={hitKey(h, i)} h={h} onOpen={onOpen} />
            ))}
          </ul>
        ))}
      {searched && hits.length === 0 && <p className="text-xs text-mute">No matches.</p>}
    </div>
  )
}
