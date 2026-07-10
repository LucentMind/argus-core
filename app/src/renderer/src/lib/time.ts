import type { TimestampFormat } from '../../../shared/settings'

export function formatTimestamp(iso: string, fmt: TimestampFormat): string {
  const d = new Date(iso)
  if (fmt === 'locale') return d.toLocaleString()
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: fmt === '12h'
  })
}
