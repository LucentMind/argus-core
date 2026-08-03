import { useEffect, useState } from 'react'

/**
 * Terminal-style "agent is thinking" row: a prompt chevron, a verb that
 * materializes out of random glyphs (matrix decode), and a blinking block
 * cursor. Mounted by ChatPane while a turn is running but nothing visible is
 * streaming — the window between send and first output, and the silent
 * stretches when tool cards are hidden.
 */

const WORDS = ['tracing', 'probing', 'reasoning', 'cross-checking']
const GLYPHS = 'アイウエオカキクケコサシスセソタチツテト0123456789<>/\\|=+*#$%&'
/** scramble refresh rate */
const TICK_MS = 45
/** ticks between locking successive characters */
const RESOLVE_TICKS = 3
/** pause once a word is fully resolved, before decoding the next one */
const HOLD_MS = 1400

function noise(length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
  return s
}

export function ThinkingIndicator(): React.JSX.Element {
  // Read once per mount: flipping the OS setting mid-run re-resolves on the
  // next mount, which is the next turn — not worth a live listener.
  const [reduceMotion] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const [wordIndex, setWordIndex] = useState(0)
  const [locked, setLocked] = useState(0)
  // bumped every scramble tick so the unresolved glyphs re-randomize
  const [, setChurn] = useState(0)
  const word = WORDS[wordIndex]!

  useEffect(() => {
    if (reduceMotion) return
    if (locked >= word.length) {
      const t = setTimeout(() => {
        setWordIndex((i) => (i + 1) % WORDS.length)
        setLocked(0)
      }, HOLD_MS)
      return () => clearTimeout(t)
    }
    let ticks = 0
    const iv = setInterval(() => {
      ticks++
      if (ticks % RESOLVE_TICKS === 0) setLocked((l) => l + 1)
      else setChurn((c) => c + 1)
    }, TICK_MS)
    return () => clearInterval(iv)
  }, [reduceMotion, word, locked])

  const settled = reduceMotion ? word : word.slice(0, locked)
  const unresolved = reduceMotion ? '' : noise(word.length - locked)
  return (
    <div
      role="status"
      aria-label="Agent is working"
      className="flex items-center gap-1.5 font-mono text-xs"
    >
      <span aria-hidden="true" className="font-bold text-signal">
        ❯
      </span>
      {/* the glyph churn is visual texture, not content — hide it from screen
          readers; the row's aria-label carries the meaning */}
      <span aria-hidden="true" className="whitespace-pre text-dim">
        {settled}
        {unresolved && <span className="text-signal/85">{unresolved}</span>}
      </span>
      <span aria-hidden="true" className="argus-term-cursor h-3 w-1.5 bg-signal" />
    </div>
  )
}
