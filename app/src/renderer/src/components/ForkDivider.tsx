import type { ForkOrigin } from '../../../shared/branching'

/**
 * Marks where a forked chat's inherited history ends and its own turns begin. `origin.branching`
 * decides the wording: the fork carried the parent's real transcript context across, or only a
 * summary of it — the reader needs to know which is true of the turns above this line.
 *
 * Read off the fork's own row (`sessions.forked_branching`, stamped at fork time) rather than
 * derived from the driver's `capabilities.branching`: the capability is a property of the
 * PROVIDER, this divider is a statement about one past event, and the two disagree for every
 * fork cut at a turn with no provider anchor (V2/V14) and for every fork whose parent's cursor
 * has since been replaced. The divider is permanent; the derivation was not.
 */
export function ForkDivider({
  origin,
  onOpenParent
}: {
  origin: ForkOrigin
  onOpenParent?: (id: number) => void
}): React.JSX.Element {
  const branching = origin.branching
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
