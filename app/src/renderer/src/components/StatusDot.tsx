/**
 * A status dot with a soft bloom.
 *
 * `color` is a Tailwind `text-*` class, and the fill comes from `bg-current`: one class then
 * drives the dot AND its halo, because the glow in main.css is `color-mix`ed off `currentColor`.
 * Passing a `bg-*` class instead would light the dot but leave the halo transparent.
 *
 * Always `aria-hidden` — every caller pairs it with the same word in text, and a screen reader
 * announcing "circle" before "Analyzing" is noise.
 */
export function StatusDot({
  color,
  size = 7,
  className = ''
}: {
  color: string
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-testid="status-dot"
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`argus-dot inline-block shrink-0 rounded-full bg-current ${color} ${className}`}
    />
  )
}
