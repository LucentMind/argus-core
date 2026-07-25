import type { DatabaseSync } from 'node:sqlite'
import type { ModeContext } from '../../shared/modes'

/**
 * The state the mode availability rules read for a case. Plan 2 (PR binding) replaces the
 * body to count the case's linked-PR bindings; until then no PR source exists, so review
 * mode is correctly unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- params are the seam Plan 2 wires up
export function modeContextForCase(_db: DatabaseSync, _caseSlug: string): ModeContext {
  return { linkedPrCount: 0 }
}
