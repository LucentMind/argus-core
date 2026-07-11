import { describe, it, expect } from 'vitest'
import { PackRegistry } from '../registry'
import type { LoadedPack } from '../loader'

function lp(id: string, personaText: string | null, assets?: { skills?: string; refs?: string }): LoadedPack {
  return {
    id,
    dir: `/packs/${id}`,
    manifest: { id, displayName: id, version: '1', argusApi: '^1' },
    personaText,
    skillsDir: assets?.skills ?? null,
    referencesDir: assets?.refs ?? null
  }
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

  it('returns asset sources in pack order, skipping packs without them', () => {
    const reg = new PackRegistry([
      lp('alpha', null, { skills: '/packs/alpha/skills' }),
      lp('beta', null),
      lp('gamma', null, { skills: '/packs/gamma/skills', refs: '/packs/gamma/references' })
    ])
    expect(reg.skillsSources()).toEqual(['/packs/alpha/skills', '/packs/gamma/skills'])
    expect(reg.referencesSources()).toEqual(['/packs/gamma/references'])
  })
})
