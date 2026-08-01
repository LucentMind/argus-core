import type { ReferenceHit } from '../../../../shared/corpusSearch'

export interface ReferencesPanelProps {
  hits: readonly ReferenceHit[]
  onOpenHit: (hit: ReferenceHit) => void
}

/** Spec §6.3, half two — the half that works *despite* there being no citation syntax. */
export function ReferencesPanel({ hits, onOpenHit }: ReferencesPanelProps): React.JSX.Element {
  return (
    <ul className="max-h-40 overflow-auto pb-1">
      {hits.map((h) => (
        <li key={`${h.kind}:${h.name}:${h.line}`} className="px-3 py-0.5 text-xs">
          <button
            type="button"
            onClick={() => onOpenHit(h)}
            className="flex w-full gap-2 text-left text-dim hover:text-ink hover:underline"
          >
            <span className="w-40 shrink-0 truncate font-mono text-faint">
              {h.name}:{h.line}
            </span>
            <span className="min-w-0 truncate">{h.text}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
