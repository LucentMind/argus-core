import { useEffect, useState } from 'react'
import type { DistillJobRow } from '../../../shared/distill'
import { Chip } from './ui'

export function DistillChip({ slug }: { slug: string }): React.JSX.Element | null {
  const [job, setJob] = useState<DistillJobRow | null>(null)

  useEffect(() => {
    let mounted = true
    void window.argus.distill.status(slug).then((j) => {
      if (mounted) setJob(j)
    })
    const off = window.argus.distill.onChanged((p) => {
      if (p.caseSlug === slug) setJob(p.job)
    })
    return () => {
      mounted = false
      off()
    }
  }, [slug])

  if (!job) return null

  if (job.state === 'queued' || job.state === 'running') {
    return <Chip>distilling…</Chip>
  }

  if (job.state === 'failed') {
    return (
      <button
        className="font-mono text-[10.5px] uppercase tracking-wide text-danger"
        onClick={() => void window.argus.distill.retry(job.id).then(setJob)}
      >
        distill failed — retry
      </button>
    )
  }

  // done
  if (job.itemCount && job.itemCount > 0) {
    return <Chip tone="signal">distilled · {job.itemCount}</Chip>
  }
  return <Chip>nothing to distill</Chip>
}
