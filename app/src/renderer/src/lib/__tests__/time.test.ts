import { describe, it, expect } from 'vitest'
import { formatTimestamp } from '../time'

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
