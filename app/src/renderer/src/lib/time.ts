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

// Compact stamp for the crowded case bar: month/day + time, no year or seconds
// (e.g. "7/15, 5:08 PM").
export function shortStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
