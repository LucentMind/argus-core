import { describe, it, expect } from 'vitest'
import { railTier } from '../priorityRail'

describe('railTier', () => {
  it('maps the real Jira priority names, case-insensitively', () => {
    expect(railTier('Highest')).toBe('p1')
    expect(railTier('High')).toBe('p1')
    expect(railTier('HIGH')).toBe('p1')
    expect(railTier('Medium')).toBe('p2')
    expect(railTier('Low')).toBe('p3')
    expect(railTier('lowest')).toBe('p3')
  })

  it('unknown or unset priorities get no rail', () => {
    expect(railTier(null)).toBeNull()
    expect(railTier('')).toBeNull()
    expect(railTier('Blocker')).toBeNull()
    expect(railTier('P1')).toBeNull() // Jira sends names, not codes — see PRIORITY_RANK
  })
})
