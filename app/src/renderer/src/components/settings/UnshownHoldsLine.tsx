import { describeUnshownHolds } from '../../../../shared/currency'

/**
 * Rendered inside a section whose held-back badge counts more items than the section has rows for.
 * The badge keeps the true count — lowering it to what happens to be on screen would make it
 * disagree with the TopBar, which is the drift `currencyStore` exists to prevent — so the section
 * explains itself instead.
 *
 * Class string matches the sibling empty-state line ("No HiveMind content matches …") rather than
 * `BlockedReasonLine`'s: this sits in a section body, not indented under a row.
 */
export function UnshownHoldsLine({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null
  return <div className="px-1 py-2 text-sm text-dim">{describeUnshownHolds(count)}</div>
}
