import { useEffect, useState } from 'react'
import type { CaseRecord } from '../../../../shared/types'
import type { DistillJobRow } from '../../../../shared/distill'
import { Btn, Checkbox } from '../ui'
import { useEscapeLayer } from '../../lib/escapeLayer'

const IN_FLIGHT_TITLE = 'A distillation is already running for this case'

/** Started from the rail's "New run…" header (case picker, `fixedSlug` unset) or from
 *  `RunDetail`'s "Run again" action (case pinned via `fixedSlug`). Real vs dry run is a local
 *  radio; dry runs default to ignoring the case's prior proposals. */
export function NewRunPopover({
  fixedSlug,
  inFlightSlugs,
  onStarted,
  onClose
}: {
  /** When set, the case picker is replaced by this slug ("Run again"). */
  fixedSlug?: string
  inFlightSlugs: ReadonlySet<string>
  onStarted: (job: DistillJobRow) => void
  onClose: () => void
}): React.JSX.Element {
  const [cases, setCases] = useState<Pick<CaseRecord, 'slug' | 'title' | 'jiraKey'>[]>([])
  const [query, setQuery] = useState('')
  const [slug, setSlug] = useState<string | null>(fixedSlug ?? null)
  const [mode, setMode] = useState<'real' | 'dry'>('real')
  const [ignorePrior, setIgnorePrior] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscapeLayer({ onEscape: onClose })

  useEffect(() => {
    if (fixedSlug) return
    let live = true
    void window.argus.cases
      .list()
      .then((cs: CaseRecord[]) => live && setCases(cs))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [fixedSlug])

  const q = query.trim().toLowerCase()
  const matches = q
    ? cases
        .filter((c) => `${c.slug} ${c.title} ${c.jiraKey ?? ''}`.toLowerCase().includes(q))
        .slice(0, 8)
    : []
  const blocked = slug !== null && inFlightSlugs.has(slug)
  const start = (): void => {
    if (pending || slug === null || blocked) return
    setPending(true)
    setError(null)
    const p =
      mode === 'dry'
        ? window.argus.distill.dryRun(slug, ignorePrior)
        : window.argus.distill.redistill(slug)
    void p
      .then((job) => {
        onStarted(job)
        onClose()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPending(false))
  }

  return (
    <div
      role="dialog"
      aria-label="New distillation run"
      className="flex w-80 flex-col gap-2 rounded-r2 border border-hair bg-overlay p-3 text-xs shadow"
    >
      {fixedSlug ? (
        <div className="font-mono text-ink">{fixedSlug}</div>
      ) : (
        <div className="relative">
          <input
            type="search"
            aria-label="Case"
            placeholder="slug, title or key"
            value={slug ?? query}
            onChange={(e) => {
              setSlug(null)
              setQuery(e.target.value)
            }}
            className="w-full rounded-r1 border border-hair bg-well px-2 py-1 text-ink"
          />
          {slug === null && matches.length > 0 && (
            <ul
              role="listbox"
              className="absolute z-10 mt-1 w-full rounded-r1 border border-hair bg-overlay"
            >
              {matches.map((c) => (
                <li
                  key={c.slug}
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    setSlug(c.slug)
                    setQuery('')
                  }}
                  className="cursor-pointer px-2 py-1 hover:bg-hair"
                >
                  {c.title} <span className="font-mono text-dim">{c.jiraKey ?? c.slug}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex gap-3">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="mode"
            aria-label="Real run"
            checked={mode === 'real'}
            onChange={() => setMode('real')}
          />{' '}
          Real
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="mode"
            aria-label="Dry run"
            checked={mode === 'dry'}
            onChange={() => setMode('dry')}
          />{' '}
          Dry
        </label>
      </div>
      {mode === 'dry' && (
        <Checkbox
          checked={ignorePrior}
          onChange={setIgnorePrior}
          label="Ignore this case's prior proposals"
          aria-label="Ignore this case's prior proposals"
        />
      )}
      {error && <div className="text-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onClose}>Close</Btn>
        <Btn
          variant="primary"
          disabled={pending || slug === null || blocked}
          title={blocked ? IN_FLIGHT_TITLE : undefined}
          onClick={start}
        >
          Start
        </Btn>
      </div>
    </div>
  )
}
