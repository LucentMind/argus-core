import { describeBlocked, SURFACED_BLOCK_KINDS } from '../../../../shared/currency'
import type { Candidate } from '../../../../shared/currency'

/**
 * The one line under a row explaining why auto-update left it alone.
 *
 * Renders nothing for a candidate with no reason, and nothing for `unsupported` — that means
 * "this build cannot update at all", which belongs on the Version row, not against an item.
 */
export function BlockedReasonLine({
  candidate
}: {
  candidate: Candidate
}): React.JSX.Element | null {
  const reason = candidate.reason
  if (!reason || !SURFACED_BLOCK_KINDS.has(reason.kind)) return null
  return <div className="pl-4 text-sm text-dim">Held back — {describeBlocked(reason)}</div>
}
