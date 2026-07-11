import { describe, it, expect } from 'vitest'
import { PackRegistry } from '../registry'
import { packManifestSchema } from '../manifest'
import type { LoadedPack } from '../loader'

function lp(id: string, personaText: string | null, assets?: { skills?: string; refs?: string }): LoadedPack {
  return {
    id,
    dir: `/packs/${id}`,
    manifest: packManifestSchema.parse({ id, displayName: id, version: '1', argusApi: '^1' }),
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

  it('flattens binary declarations across packs in order', () => {
    const a = lp('alpha', null)
    a.manifest = packManifestSchema.parse({
      id: 'alpha',
      displayName: 'alpha',
      version: '1',
      argusApi: '^1',
      binaries: [
        {
          id: 'tool-a',
          kind: 'exe',
          displayName: 'Tool A',
          names: ['tool-a'],
          devPaths: []
        }
      ]
    })
    const b = lp('beta', null)
    const reg = new PackRegistry([a, b])
    const decls = reg.binaryDecls()
    expect(decls).toHaveLength(1)
    expect(decls[0].decl.id).toBe('tool-a')
    expect(decls[0].packDir).toBe('/packs/alpha')
  })

  it('flattens detector declarations in pack order', () => {
    const a = lp('alpha', null)
    a.manifest = packManifestSchema.parse({
      id: 'alpha', displayName: 'A', version: '1', argusApi: '^1',
      detectors: [{ type: 'binlog', match: [{ nameEndsWith: ['.binlog'] }] }]
    })
    const reg = new PackRegistry([a, lp('beta', null)])
    expect(reg.detectorDecls().map((d) => d.type)).toEqual(['binlog'])
  })
})
