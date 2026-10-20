import { useEffect, useMemo, useState } from 'react'
import type { AssetUsefulness } from '../../../../shared/attribution'
import { MIN_APPLIED } from '../../../../shared/attribution'
import { Chip } from '../ui'

export const USEFULNESS_CAVEAT =
  'LLM-judged from the case transcript · relative ranking · retractions and rejections override'
const ALL = 'All domains'
const CARD_ID = 'usefulness.assets'

interface Counts {
  applied: number
  helped: number
  neutral: number
  misled: number
}

/** Same rule as `aggregateAttributions`: under MIN_APPLIED (or nothing judged) there is no rate. */
function rate(c: Counts): string | null {
  const judged = c.helped + c.neutral + c.misled
  if (c.applied < MIN_APPLIED || judged === 0) return null
  return `${Math.round((c.helped / judged) * 100)}%`
}

export function UsefulnessCards({
  hiddenCards
}: {
  hiddenCards: readonly string[]
}): React.JSX.Element | null {
  const [rows, setRows] = useState<AssetUsefulness[] | null>(null)
  const [domain, setDomain] = useState(ALL)
  useEffect(() => {
    let live = true
    void window.argus.usage
      .stats()
      .then((u) => {
        // `usefulness` may be absent from older/partial payloads; treat as empty.
        if (live) setRows(u.usefulness ?? [])
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const domains = useMemo(
    () => Array.from(new Set((rows ?? []).flatMap((r) => Object.keys(r.byDomain)))).sort(),
    [rows]
  )
  if (hiddenCards.includes(CARD_ID) || !rows || rows.length === 0) return null
  const view: { r: AssetUsefulness; c: Counts; pct: string | null }[] = []
  for (const r of rows) {
    if (domain === ALL) {
      // The shared aggregate is the authority for the all-domains rate.
      const pct = r.helpedRate !== null ? `${Math.round(r.helpedRate * 100)}%` : rate(r)
      view.push({ r, c: r, pct })
    } else {
      const c = r.byDomain[domain]
      if (c) view.push({ r, c, pct: rate(c) })
    }
  }
  return (
    <section className="flex flex-col gap-2" data-testid="usefulness-cards" data-card-id={CARD_ID}>
      <div className="flex items-center gap-2">
        <h2 className="text-xs uppercase tracking-wide text-dim">Knowledge usefulness</h2>
        <select
          aria-label="Domain"
          className="rounded-r1 border border-hair bg-transparent px-1 text-xs"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        >
          {[ALL, ...domains].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-mute">{USEFULNESS_CAVEAT}</p>
      <table className="w-full text-xs">
        <thead className="text-dim">
          <tr>
            <th className="text-left">asset</th>
            <th>kind</th>
            <th>applied</th>
            <th>helped</th>
            <th>misled</th>
            <th>helped rate</th>
            <th className="text-left">domains</th>
          </tr>
        </thead>
        <tbody>
          {view.map(({ r, c, pct }) => (
            <tr key={`${r.kind}/${r.name}`} className="border-b border-hair">
              <td className="py-1 font-mono">{r.name}</td>
              <td className="text-center text-dim">{r.kind}</td>
              <td className="text-center">{c.applied}</td>
              <td className="text-center">{c.helped}</td>
              <td className="text-center">{c.misled}</td>
              <td className="text-center">{pct ?? <span title="too few cases">—</span>}</td>
              {/* A flex <td> stops being a table cell (columns misalign); the flex wrapper is
                  an inner div. */}
              <td className="py-1">
                <div className="flex flex-wrap gap-1">
                  {r.emergentDomains.map((d) => (
                    <Chip key={d} tone="neutral">
                      {d}
                    </Chip>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
