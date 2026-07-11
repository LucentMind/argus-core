import { describe, it, expect } from 'vitest'
import { packManifestSchema, PACK_MANIFEST_FILE } from '../manifest'

describe('packManifestSchema', () => {
  const valid = { id: 'sample', displayName: 'Navigation', version: '1.0.0', argusApi: '^1' }

  it('parses a minimal valid manifest', () => {
    const m = packManifestSchema.parse(valid)
    expect(m.id).toBe('sample')
    expect(m.persona).toBeUndefined()
  })

  it('accepts an optional persona path', () => {
    expect(packManifestSchema.parse({ ...valid, persona: 'persona.md' }).persona).toBe('persona.md')
  })

  it('rejects a manifest missing id', () => {
    expect(() => packManifestSchema.parse({ displayName: 'X', version: '1', argusApi: '^1' })).toThrow()
  })

  it('rejects a non-kebab id', () => {
    expect(() => packManifestSchema.parse({ ...valid, id: 'Nav Pack' })).toThrow()
  })

  it('passes unknown future fields through untouched', () => {
    const m = packManifestSchema.parse({ ...valid, binaries: [{ id: 'x' }] }) as Record<string, unknown>
    expect(m.binaries).toEqual([{ id: 'x' }])
  })

  it('exposes the manifest filename', () => {
    expect(PACK_MANIFEST_FILE).toBe('argus-pack.json')
  })
})
