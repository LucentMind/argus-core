import { useMemo, useState } from 'react'

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * Port of t3code's `redactedPlaceholder` (FNV-1a hash → alphabet stream),
 * scrambling everything except `@ . - _` so an email-shaped string still
 * *looks* email-shaped while blurred.
 */
function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    state ^= value.charCodeAt(i)
    state = Math.imul(state, 0x01000193)
  }
  function nextChar(): string {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b)
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35)
    return ALPHABET[Math.abs(state) % ALPHABET.length] ?? 'x'
  }
  return Array.from(value, (ch) => {
    if (ch === '@' || ch === '.' || ch === '-' || ch === '_') return ch
    return nextChar()
  }).join('')
}

/**
 * Blurred-by-default sensitive text (t3code `RedactedSensitiveText`, OEH-styled).
 * Click toggles between the scrambled placeholder and the real value.
 */
export function RedactedText({
  value,
  'aria-label': ariaLabel,
  className = ''
}: {
  value: string
  'aria-label': string
  className?: string
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const redacted = useMemo(() => redactedPlaceholder(value), [value])
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={revealed ? 'Click to hide' : 'Click to reveal'}
      className={`min-w-0 cursor-pointer truncate rounded-r1 font-mono text-xs transition-colors hover:text-ink ${
        revealed ? 'text-mute' : 'select-none text-mute blur-[2px]'
      } ${className}`}
      onClick={() => setRevealed((r) => !r)}
    >
      {revealed ? value : redacted}
    </button>
  )
}
