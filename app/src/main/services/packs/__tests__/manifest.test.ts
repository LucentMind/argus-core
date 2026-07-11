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
    const m = packManifestSchema.parse({ ...valid, unknownFuture: 'value' }) as Record<string, unknown>
    expect(m.unknownFuture).toBe('value')
  })

  it('exposes the manifest filename', () => {
    expect(PACK_MANIFEST_FILE).toBe('argus-pack.json')
  })

  it('parses binaries[] declarations', () => {
    const m = packManifestSchema.parse({
      ...valid,
      binaries: [
        {
          id: 'sample-parse',
          kind: 'exe',
          displayName: 'sample-parse binary',
          envVar: 'ARGUS_PARSE_BIN',
          settingsKey: 'parseBin',
          names: ['sample-parse'],
          devPaths: ['../../trace-rs/target/release'],
          versionArgs: ['--version'],
          pathProbeArgs: ['doctor']
        },
        {
          id: 'sample-trace',
          kind: 'pathDir',
          displayName: 'sample-trace CLI',
          names: ['sample-trace'],
          devPaths: ['../../trace-tools/.venv/{platformBin}'],
          doctor: { cmd: 'sample-trace', args: ['doctor', '--json'], json: true }
        }
      ]
    })
    expect(m.binaries).toHaveLength(2)
    expect(m.binaries[0].description).toBe('')
    expect(m.binaries[1].doctor?.json).toBe(true)
  })

  it('accepts a platforms filter and rejects unknown platform names', () => {
    const bin = { id: 'x', kind: 'exe', displayName: 'X', names: ['x'] }
    const m = packManifestSchema.parse({ ...valid, binaries: [{ ...bin, platforms: ['win32'] }] })
    expect(m.binaries[0].platforms).toEqual(['win32'])
    expect(() =>
      packManifestSchema.parse({ ...valid, binaries: [{ ...bin, platforms: ['windows'] }] })
    ).toThrow()
  })

  it('defaults binaries to empty and rejects a bad kind', () => {
    expect(packManifestSchema.parse(valid).binaries).toEqual([])
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        binaries: [{ id: 'x', kind: 'nope', displayName: 'X', names: ['x'] }]
      })
    ).toThrow()
  })

  it('parses detectors[] declarations', () => {
    const m = packManifestSchema.parse({
      ...valid,
      detectors: [
        {
          type: 'binlog',
          displayName: 'Binary log',
          analyzeSkill: 'analyze-binlog',
          match: [{ magicHex: '444C5401' }, { nameEndsWith: ['.binlog'] }],
          extract: { bin: 'sample-parse', args: ['binlog-to-text', '{input}', '--output', '{output}'] }
        },
        { type: 'applog', isText: true, match: [{ headRegex: { source: '^\\d{2}-\\d{2}', flags: 'm' } }] }
      ]
    })
    expect(m.detectors).toHaveLength(2)
    expect(m.detectors[0].displayName).toBe('Binary log')
    expect(m.detectors[0].isText).toBe(false)
    expect(m.detectors[1].displayName).toBe('applog') // defaults to type
  })

  it('defaults detectors to empty and rejects a rule-less detector', () => {
    expect(packManifestSchema.parse(valid).detectors).toEqual([])
    expect(() =>
      packManifestSchema.parse({ ...valid, detectors: [{ type: 'x', match: [] }] })
    ).toThrow()
  })

  it('rejects a detector with a non-kebab type or odd-length magicHex', () => {
    expect(() =>
      packManifestSchema.parse({ ...valid, detectors: [{ type: 'Bad Type', match: [{ nameEndsWith: ['.x'] }] }] })
    ).toThrow()
    expect(() =>
      packManifestSchema.parse({ ...valid, detectors: [{ type: 'x', match: [{ magicHex: 'ABC' }] }] })
    ).toThrow()
  })
})
