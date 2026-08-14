import React, { useEffect, useState } from 'react'
import type { QueueProgressEvent } from '../../../shared/evidenceProgress'

type QueueState = Omit<QueueProgressEvent, 'slug'>

const MB = 1024 * 1024
const mb = (bytes: number): string => `${Math.round(bytes / MB)} MB`

/**
 * Aggregate progress for one case's background ingest queue.
 *
 * Weighted by bytes rather than file count: a queue of one 500MB trace and six
 * small logs would otherwise sit at "6 of 7" for minutes and read as stuck.
 *
 * bytesTotal/bytesDone only ever count indexable jobs (ingestQueue.ts) — a drop
 * of screenshots with no extractor produces filesTotal > 0 with bytesTotal === 0
 * for the whole run. Byte-driven progress falls back to file counts in that
 * case, both for the bar's fill and for its label, rather than showing a
 * permanent 0% / "0 MB of 0 MB".
 *
 * Renders nothing when the queue is empty — the drain event zeroes every
 * counter, which is exactly the signal that hides the bar.
 */
export function IngestProgressBar({ caseSlug }: { caseSlug: string }): React.JSX.Element | null {
  const [state, setState] = useState<QueueState | null>(null)
  // "Adjusting state when a prop changes" (react.dev), not a setState-in-effect: a different
  // case's queue tells us nothing about this one, so a slug switch must drop stale state
  // before paint rather than flashing the old case's bar for one frame.
  const [seenSlug, setSeenSlug] = useState(caseSlug)
  if (seenSlug !== caseSlug) {
    setSeenSlug(caseSlug)
    setState(null)
  }

  useEffect(() => {
    return window.argus.evidence.onQueueProgress((p) => {
      if (p.slug !== caseSlug) return
      setState(
        p.filesTotal === 0
          ? null
          : {
              filesDone: p.filesDone,
              filesTotal: p.filesTotal,
              bytesDone: p.bytesDone,
              bytesTotal: p.bytesTotal
            }
      )
    })
  }, [caseSlug])

  if (!state) return null
  const byBytes = state.bytesTotal > 0
  const pct = byBytes
    ? Math.min(100, Math.round((state.bytesDone / state.bytesTotal) * 100))
    : Math.min(100, Math.round((state.filesDone / state.filesTotal) * 100))

  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Indexing evidence"
        className="h-1 w-full overflow-hidden rounded-r1 bg-well"
      >
        <span
          className="block h-full bg-signal transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-mute">
        {state.filesDone} of {state.filesTotal} files
        {byBytes && ` · ${mb(state.bytesDone)} of ${mb(state.bytesTotal)}`}
      </span>
    </div>
  )
}
