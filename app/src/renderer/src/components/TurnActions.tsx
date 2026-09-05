import { MenuButton } from './ui'

/**
 * Per-turn "⋯" menu on a live turn's last assistant reply: "Rewind to here" discards
 * everything after this turn (composer prefilled with the first discarded prompt),
 * "Fork from here" branches a new sibling chat that inherits up to this turn. Mounted
 * only on live items (see `ChatPane.renderItem`'s `!opts.rewound` gate) — a rewound
 * turn is history, not a place to click.
 */
export function TurnActions({
  turnId,
  canRewind,
  disabledReason,
  onRewind,
  onFork
}: {
  turnId: number
  canRewind: boolean
  /** Non-null while a turn is running — disables both actions and supplies the tooltip. */
  disabledReason: string | null
  onRewind: (turnId: number) => void
  onFork: (turnId: number) => void
}): React.JSX.Element {
  return (
    <div className="absolute -right-6 top-0 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100">
      <MenuButton
        label="⋯"
        nocaret
        portal
        size="iconXs"
        aria-label="turn actions"
        title="Rewind or fork from this reply"
        items={[
          {
            label: 'Rewind to here',
            disabled: !canRewind || !!disabledReason,
            title: disabledReason ?? undefined,
            onSelect: () => onRewind(turnId)
          },
          {
            label: 'Fork from here',
            disabled: !!disabledReason,
            title: disabledReason ?? undefined,
            onSelect: () => onFork(turnId)
          }
        ]}
      />
    </div>
  )
}
