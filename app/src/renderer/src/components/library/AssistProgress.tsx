import { useEffect, useState } from 'react'
import { Btn } from '../ui'

const PHASE_LABEL = { draft: 'Drafting', improve: 'Improving' } as const

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * The row shown while an assist request is in flight.
 *
 * It owns its own timer by virtue of being mounted only while the request is running —
 * mount starts the interval, unmount clears it, so there is no separate start/stop state to
 * keep in sync with `busy`.
 *
 * "Stop waiting", never "Cancel": the modal chrome already has a Cancel that closes the
 * editor, and two adjacent controls reading "Cancel" with different consequences is a trap.
 * The wording is also literal — the model keeps running, and only its result is discarded.
 */
export function AssistProgress({
  phase,
  providerText,
  onStopWaiting
}: {
  phase: 'draft' | 'improve'
  providerText?: string
  onStopWaiting: () => void
}): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex items-center gap-3 border-t border-hair px-3 py-2">
      <span role="status" className="font-mono text-xs text-dim">
        {PHASE_LABEL[phase]}… {mmss(seconds)}
      </span>
      {providerText && <span className="truncate text-xs text-faint">{providerText}</span>}
      <span className="flex-1" />
      <Btn
        variant="ghost"
        onClick={onStopWaiting}
        title="Discard this run's result and get the editor back. The model keeps running."
      >
        Stop waiting
      </Btn>
    </div>
  )
}
