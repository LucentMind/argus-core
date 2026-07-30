import { useEffect, useRef, useState } from 'react'

/**
 * Should a pending indicator be on screen right now?
 *
 * Two guards against the same failure. A skeleton that appears and vanishes inside a couple of
 * frames reads as jank, and several surfaces this gates resolve from local SQLite in well under
 * 50ms — so nothing shows for `delayMs`, and once something HAS shown it stays for `minMs`.
 *
 * The optimistic rows on the action surfaces deliberately do NOT use this: they carry real
 * content from their first frame and transition a field in place, so there is nothing to strobe.
 *
 * Every state write goes through a timeout rather than running in the effect body, which keeps
 * `react-hooks/set-state-in-effect` satisfied without a disable comment.
 */
export function usePendingDisplay(active: boolean, delayMs = 150, minMs = 300): boolean {
  const [shown, setShown] = useState(false)
  const shownAt = useRef<number | null>(null)

  useEffect(() => {
    if (active === shown) return
    const wait = active ? delayMs : Math.max(0, minMs - (Date.now() - (shownAt.current ?? 0)))
    const t = setTimeout(() => {
      if (active) shownAt.current = Date.now()
      setShown(active)
    }, wait)
    return () => clearTimeout(t)
  }, [active, shown, delayMs, minMs])

  return shown
}
