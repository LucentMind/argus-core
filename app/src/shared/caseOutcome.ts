import type { CaseResolution, CaseStatus } from './types'

/** Derived, never judged: the attribution stage receives this as context and may not override it (spec §4.2). */
export type CaseOutcome =
  'solved' | 'solved-unconfirmed' | 'closed-unresolved' | 'handed-off' | 'rejected' | 'open'

export const CASE_OUTCOMES: readonly CaseOutcome[] = [
  'solved',
  'solved-unconfirmed',
  'closed-unresolved',
  'handed-off',
  'rejected',
  'open'
]

export function deriveCaseOutcome(
  c: { status: CaseStatus; resolution: CaseResolution | null },
  findings: { reviewState: string; role: string | null }[]
): CaseOutcome {
  if (c.status !== 'closed' || c.resolution === null) return 'open'
  switch (c.resolution) {
    case 'solved': {
      const confirmed = findings.some(
        (f) => f.reviewState === 'accepted' && f.role === 'root-cause'
      )
      return confirmed ? 'solved' : 'solved-unconfirmed'
    }
    case 'not-reproducible':
    case 'wont-fix':
      return 'closed-unresolved'
    case 'forwarded':
    case 'duplicate':
      return 'handed-off'
    case 'rejected':
      return 'rejected'
  }
}
