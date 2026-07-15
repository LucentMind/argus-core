import { describe, it, expect } from 'vitest'
import { formatTimestamp, chipStamp } from '../time'

const iso = '2026-07-10T15:04:05.000Z'

describe('formatTimestamp', () => {
  it('locale delegates to toLocaleString', () => {
    expect(formatTimestamp(iso, 'locale')).toBe(new Date(iso).toLocaleString())
  })
  it('24h has no day-period; 12h differs from 24h', () => {
    const h24 = formatTimestamp(iso, '24h')
    const h12 = formatTimestamp(iso, '12h')
    expect(h24).not.toMatch(/am|pm/i)
    expect(h12).not.toBe(h24)
  })
})

describe('chipStamp', () => {
  it('formats as "D Mon, HH:MM" in local time, zero-padded', () => {
    const iso = '2026-03-14T09:32:00.000Z'
    const d = new Date(iso)
    const expected = `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}, ${String(
      d.getHours()
    ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(chipStamp(iso)).toBe(expected)
  })
})
