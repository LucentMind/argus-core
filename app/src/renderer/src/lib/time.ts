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

// Evidence-chip meta row stamp: day + short month + 24h time, e.g. "14 Mar, 09:32".
// Deliberately distinct from shortStamp (numeric month/day + AM/PM, used by the case bar).
export function chipStamp(iso: string): string {
  const d = new Date(iso)
  const day = d.getDate()
  const month = d.toLocaleString(undefined, { month: 'short' })
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${month}, ${hh}:${mm}`
}
