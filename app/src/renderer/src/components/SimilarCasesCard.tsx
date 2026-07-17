import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { SummarySearchHit } from '../../../shared/distill'
import { Card, Chip, IconBtn, SectionLabel } from './ui'

function dismissKey(slug: string): string {
  return `argus:similar-dismissed:${slug}`
}

export function SimilarCasesCard({
  slug,
  onOpenCase
}: {
  slug: string
  onOpenCase?: (slug: string) => void
}): React.JSX.Element | null {
  const [hits, setHits] = useState<SummarySearchHit[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const alreadyDismissed = Boolean(localStorage.getItem(dismissKey(slug)))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(alreadyDismissed)
    setHits([])
    if (alreadyDismissed) return
    let mounted = true
    void window.argus.distill.similar(slug).then((r) => {
      if (mounted) setHits(r)
    })
    return () => {
      mounted = false
    }
  }, [slug])

  if (dismissed || hits.length === 0) return null

  function dismiss(): void {
    localStorage.setItem(dismissKey(slug), '1')
    setDismissed(true)
  }

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Similar past cases</SectionLabel>
        <IconBtn aria-label="Dismiss" onClick={dismiss}>
          <X size={14} strokeWidth={1.5} />
        </IconBtn>
      </div>
      <div className="flex flex-col gap-1.5">
        {hits.map((hit) => (
          <div key={hit.caseSlug} className="flex items-center gap-2">
            <button
              className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:text-signal"
              onClick={() => onOpenCase?.(hit.caseSlug)}
            >
              {hit.signature}
            </button>
            <Chip>{hit.resolution}</Chip>
          </div>
        ))}
      </div>
    </Card>
  )
}
