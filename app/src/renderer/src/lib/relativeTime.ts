/**
 * "just now" under a minute, then whole minutes/hours. Formatted at render rather than
 * stored, so a label decays on its own as time passes without new data arriving.
 *
 * Lives outside the component file so fast refresh keeps working (a module that exports
 * both components and plain functions can't be hot-swapped).
 */
export function relativeChecked(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}
