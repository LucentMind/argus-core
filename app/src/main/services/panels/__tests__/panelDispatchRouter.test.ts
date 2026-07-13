import { describe, it, expect } from 'vitest'
import { routeByKind } from '../routeByKind'

describe('routeByKind', () => {
  it('routes externalApp to the process host and webPanel to the panel host', () => {
    const kindOf = (_p: string, w: string): 'webPanel' | 'externalApp' | null =>
      w === 'sim' ? 'externalApp' : w === 'viewer' ? 'webPanel' : null
    expect(routeByKind(kindOf, 'pk', 'sim')).toBe('externalApp')
    expect(routeByKind(kindOf, 'pk', 'viewer')).toBe('webPanel')
    expect(routeByKind(kindOf, 'pk', 'nope')).toBeNull()
  })
})
