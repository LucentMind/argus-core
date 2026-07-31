import { Lock } from 'lucide-react'
import { Btn } from '../ui'
import { TIER_EXPLANATIONS, type TrustTier } from '../../../../shared/trustTiers'
import type { AuthoringKind } from '../../../../shared/authoringIpc'

export interface ReadOnlyNoticeProps {
  kind: AuthoringKind
  name: string
  tier: string | null
  onEditCopy: () => void
}

/**
 * Spec §6.2: a protected asset opens read-only, with a prominent way out.
 *
 * The way out is the point. Without it this is a dead end — and for skills it replaces a flatly
 * false error: `readSkill` returns the tier-winning copy while `writeUserSkill` always writes to
 * `skills-user`, so saving a bundled skill today fails with `"x" changed on disk since you
 * opened it` when nothing changed on disk at all.
 *
 * The explanation is `TIER_EXPLANATIONS`, not a second wording of the same fact — the Library
 * already says this about these tiers and the two must not drift.
 */
export function ReadOnlyNotice({
  kind,
  name,
  tier,
  onEditCopy
}: ReadOnlyNoticeProps): React.JSX.Element {
  const explanation =
    tier && tier in TIER_EXPLANATIONS ? TIER_EXPLANATIONS[tier as TrustTier] : null
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-hair bg-hi px-4 py-2 text-xs text-dim"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Lock size={13} aria-hidden="true" className="shrink-0" />
        <span className="truncate" title={name}>
          This {kind} is read-only.{explanation ? ` ${explanation}` : ''}
        </span>
      </span>
      <Btn variant="outline" onClick={onEditCopy}>
        Edit a copy
      </Btn>
    </div>
  )
}
