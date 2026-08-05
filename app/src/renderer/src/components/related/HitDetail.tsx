import type { RelatedHit } from '../../../../shared/relatedHistory'

export function HitDetail({
  hit
}: {
  hit: RelatedHit
  onOpenCase?: (slug: string) => void
}): React.JSX.Element {
  return <h3 className="text-sm text-ink">{hit.title}</h3>
}
