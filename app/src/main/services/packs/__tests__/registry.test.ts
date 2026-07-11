import { describe, it, expect } from 'vitest'
import { PackRegistry } from '../registry'
import type { LoadedPack } from '../loader'

function lp(id: string, personaText: string | null): LoadedPack {
  return { id, dir: `/packs/${id}`, manifest: { id, displayName: id, version: '1', argusApi: '^1' }, personaText }
}

describe('PackRegistry', () => {
  it('returns persona fragments in pack order, skipping nulls', () => {
    const reg = new PackRegistry([lp('alpha', 'A RULES'), lp('beta', null), lp('gamma', 'G RULES')])
    expect(reg.personaFragments()).toEqual(['A RULES', 'G RULES'])
  })

  it('is empty when no packs are installed', () => {
    const reg = new PackRegistry([])
    expect(reg.personaFragments()).toEqual([])
    expect(reg.packs()).toEqual([])
  })
})
