import type { ForkOrigin } from '../../../shared/branching'

/**
 * Marks where a forked chat's inherited history ends and its own turns begin. `branching`
 * decides the wording: a native driver carried the parent's real transcript context across the
 * fork, a digest driver only carried a summary of it — the reader needs to know which is true
 * of the turns above this line.
 */
export function ForkDivider({
  origin,
  branching,
  onOpenParent
}: {
  origin: ForkOrigin
  branching: 'native' | 'digest'
  onOpenParent?: (id: number) => void
}): React.JSX.Element {
  return (
    <div role="note" className="my-2 flex items-center gap-2 text-[11px] text-mute">
      <span className="h-px flex-1 bg-hair" />
      <span>
        Forked from chat {origin.sessionId} ·{' '}
        {branching === 'native'
          ? 'full context carried over'
          : 'a summary of the history carried over'}
      </span>
      {onOpenParent && (
        <button
          type="button"
          aria-label="open parent chat"
          className="underline hover:text-dim"
          onClick={() => onOpenParent(origin.sessionId)}
        >
          open
        </button>
      )}
      <span className="h-px flex-1 bg-hair" />
    </div>
  )
}
