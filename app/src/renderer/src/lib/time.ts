export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
}

// Wall-clock only, no date: the editor's draft and restore stamps are always same-session
// ("Draft · 3:42 PM").
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// Evidence-chip meta row stamp: day + short month + 24h time, e.g. "14 Mar, 09:32".
export function chipStamp(iso: string): string {
  const d = new Date(iso)
  const day = d.getDate()
  const month = d.toLocaleString(undefined, { month: 'short' })
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${month}, ${hh}:${mm}`
}
