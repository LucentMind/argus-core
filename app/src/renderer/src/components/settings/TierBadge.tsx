import { Chip } from '../ui'
import {
  TRUST_TIERS,
  TIER_LABELS,
  TIER_EXPLANATIONS,
  type TrustTier
} from '../../../../shared/trustTiers'

/** Provenance chip for a knowledge asset; tooltip explains the tier ladder entry. */
export function TierBadge({ tier }: { tier: string }): React.JSX.Element | null {
  if (!(TRUST_TIERS as readonly string[]).includes(tier)) return null
  const t = tier as TrustTier
  return (
    <Chip tone="neutral" title={TIER_EXPLANATIONS[t]}>
      {TIER_LABELS[t]}
    </Chip>
  )
}
