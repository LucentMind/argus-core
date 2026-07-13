import { describe, it, expect } from 'vitest'
import { packManifestSchema, PACK_MANIFEST_FILE, PACK_API_VERSION, packWindowSchema } from '../manifest'

describe('packManifestSchema', () => {
  const valid = { id: 'sample', displayName: 'Sample', version: '1.0.0', argusApi: '^1' }

  it('parses a minimal valid manifest', () => {
    const m = packManifestSchema.parse(valid)
    expect(m.id).toBe('sample')
    expect(m.persona).toBeUndefined()
  })

  it('accepts an optional persona path', () => {
    expect(packManifestSchema.parse({ ...valid, persona: 'persona.md' }).persona).toBe('persona.md')
  })

  it('rejects a manifest missing id', () => {
    expect(() =>
      packManifestSchema.parse({ displayName: 'X', version: '1', argusApi: '^1' })
    ).toThrow()
  })

  it('rejects a non-kebab id', () => {
    expect(() => packManifestSchema.parse({ ...valid, id: 'Nav Pack' })).toThrow()
  })

  it('passes unknown future fields through untouched', () => {
    const m = packManifestSchema.parse({ ...valid, unknownFuture: 'value' }) as Record<
      string,
      unknown
    >
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
          devPaths: ['bin-src/trace-rs/target/release', '../../trace-rs/target/release'],
          versionArgs: ['--version'],
          pathProbeArgs: ['doctor']
        },
        {
          id: 'sample-trace',
          kind: 'pathDir',
          displayName: 'sample-trace CLI',
          names: ['sample-trace'],
          devPaths: ['bin-src/trace-tools/.venv/{platformBin}', '../../trace-tools/.venv/{platformBin}'],
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

  it('rejects a binaries entry whose names collide with a risk-classified program', () => {
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        binaries: [{ id: 'x', kind: 'exe', displayName: 'X', names: ['git'] }]
      })
    ).toThrow()
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        binaries: [{ id: 'x', kind: 'exe', displayName: 'X', names: ['gh'] }]
      })
    ).toThrow()
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        binaries: [{ id: 'x', kind: 'exe', displayName: 'X', names: ['rm'] }]
      })
    ).toThrow()
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        binaries: [{ id: 'x', kind: 'exe', displayName: 'X', names: ['cd'] }]
      })
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
        {
          type: 'applog',
          isText: true,
          match: [{ headRegex: { source: '^\\d{2}-\\d{2}', flags: 'm' } }]
        }
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
      packManifestSchema.parse({
        ...valid,
        detectors: [{ type: 'Bad Type', match: [{ nameEndsWith: ['.x'] }] }]
      })
    ).toThrow()
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        detectors: [{ type: 'x', match: [{ magicHex: 'ABC' }] }]
      })
    ).toThrow()
  })

  it('parses referenceRouting[] declarations and defaults to empty', () => {
    expect(packManifestSchema.parse(valid).referenceRouting).toEqual([])
    const m = packManifestSchema.parse({
      ...valid,
      referenceRouting: [
        { keywords: ['binlog', 'automotive', 'OEM-A binlog', 'bintrace'], target: 'binlog-protocol.md' }
      ]
    })
    expect(m.referenceRouting).toEqual([
      { keywords: ['binlog', 'automotive', 'OEM-A binlog', 'bintrace'], target: 'binlog-protocol.md' }
    ])
  })

  it('rejects a referenceRouting rule with a bad target (not a .md basename)', () => {
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        referenceRouting: [{ keywords: ['x'], target: '../../../evil.md' }]
      })
    ).toThrow()
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        referenceRouting: [{ keywords: ['x'], target: 'no-extension' }]
      })
    ).toThrow()
    expect(() =>
      packManifestSchema.parse({
        ...valid,
        referenceRouting: [{ keywords: [], target: 'x.md' }]
      })
    ).toThrow() // keywords must be non-empty
  })
})

describe('platform field + PACK_API_VERSION', () => {
  const valid = { id: 'sample', displayName: 'Sample', version: '1.0.0', argusApi: '^1' }

  it('accepts an optional <os>-<arch> platform', () => {
    expect(packManifestSchema.parse({ ...valid, platform: 'mac-arm64' }).platform).toBe('mac-arm64')
  })

  it('leaves platform undefined when absent (dev manifests)', () => {
    expect(packManifestSchema.parse(valid).platform).toBeUndefined()
  })

  it('rejects a malformed platform string', () => {
    expect(() => packManifestSchema.parse({ ...valid, platform: 'macOS' })).toThrow()
  })

  it('exports PACK_API_VERSION = 1', () => {
    expect(PACK_API_VERSION).toBe(1)
  })
})

describe('windows[] schema', () => {
  const base = { id: 'nav', displayName: 'Nav', version: '1.0.0', argusApi: '^1' }

  it('parses a webPanel window with defaults filled in', () => {
    const m = packManifestSchema.parse({
      ...base,
      windows: [{ id: 'log-viewer', kind: 'webPanel', title: 'Log Viewer', entry: 'log-viewer/index.html' }]
    })
    expect(m.windows[0]).toMatchObject({
      id: 'log-viewer',
      kind: 'webPanel',
      title: 'Log Viewer',
      entry: 'log-viewer/index.html',
      handles: [],
      placement: 'tab',
      network: [],
      permissions: []
    })
  })

  it('defaults windows to [] when absent', () => {
    expect(packManifestSchema.parse(base).windows).toEqual([])
  })

  it('keeps declared handles / network / read permissions', () => {
    const m = packManifestSchema.parse({
      ...base,
      windows: [
        {
          id: 'log-viewer',
          kind: 'webPanel',
          title: 'Log Viewer',
          entry: 'index.html',
          handles: ['logcat', 'dlt-text'],
          network: ['https://tiles.example.com'],
          permissions: ['getCaseContext', 'requestEvidence', 'readEvidence']
        }
      ]
    })
    expect(m.windows[0].handles).toEqual(['logcat', 'dlt-text'])
    expect(m.windows[0].network).toEqual(['https://tiles.example.com'])
    expect(m.windows[0].permissions).toEqual(['getCaseContext', 'requestEvidence', 'readEvidence'])
  })

  it('rejects a non-kebab window id', () => {
    expect(() =>
      packManifestSchema.parse({ ...base, windows: [{ id: 'Log_Viewer', kind: 'webPanel', title: 'T', entry: 'i.html' }] })
    ).toThrow()
  })

  it('rejects a non-webPanel kind in 3a', () => {
    expect(() =>
      packManifestSchema.parse({ ...base, windows: [{ id: 'x', kind: 'externalApp', title: 'T', entry: 'i.html' }] })
    ).toThrow()
  })

  it('tolerates unknown window keys (passthrough)', () => {
    const parsed = packManifestSchema.parse({
      ...base,
      windows: [{ id: 'x', kind: 'webPanel', title: 'T', entry: 'i.html', someFutureField: 'x' }]
    })
    expect((parsed.windows[0] as Record<string, unknown>).someFutureField).toBe('x')
  })
})

describe('packWindowSchema · 3b write permissions', () => {
  it('accepts the write verbs cite/emitFinding/sendToAgent', () => {
    const parsed = packWindowSchema.parse({
      id: 'pg', kind: 'webPanel', title: 'PG', entry: 'pg/index.html',
      permissions: ['getCaseContext', 'cite', 'emitFinding', 'sendToAgent']
    })
    expect(parsed.permissions).toContain('emitFinding')
  })

  it('rejects an unknown permission verb', () => {
    expect(() =>
      packWindowSchema.parse({
        id: 'pg', kind: 'webPanel', title: 'PG', entry: 'pg/index.html',
        permissions: ['deleteEverything']
      })
    ).toThrow()
  })
})

describe('packWindowSchema · 3b-2 commands', () => {
  it('accepts commands with id/risk/args and defaults args to []', () => {
    const w = packWindowSchema.parse({
      id: 'pg', kind: 'webPanel', title: 'PG', entry: 'pg/index.html',
      commands: [{ id: 'highlight', risk: 'low', args: ['line'] }, { id: 'echo', risk: 'medium' }]
    })
    expect(w.commands).toEqual([
      { id: 'highlight', risk: 'low', args: ['line'] },
      { id: 'echo', risk: 'medium', args: [] }
    ])
  })
  it('rejects a non-kebab command id and an invalid risk', () => {
    expect(() => packWindowSchema.parse({ id: 'p', kind: 'webPanel', title: 'P', entry: 'p/i.html', commands: [{ id: 'Bad_Id', risk: 'low' }] })).toThrow()
    expect(() => packWindowSchema.parse({ id: 'p', kind: 'webPanel', title: 'P', entry: 'p/i.html', commands: [{ id: 'ok', risk: 'critical' }] })).toThrow()
  })
  it('defaults commands to [] when absent', () => {
    const w = packWindowSchema.parse({ id: 'p', kind: 'webPanel', title: 'P', entry: 'p/i.html' })
    expect(w.commands).toEqual([])
  })
  it('accepts a command description + per-arg descriptions', () => {
    const w = packWindowSchema.parse({
      id: 'pg', kind: 'webPanel', title: 'PG', entry: 'pg/index.html',
      commands: [
        { id: 'highlight', risk: 'low', args: ['line'],
          description: 'Highlight a line.', argDescriptions: { line: '1-based line number' } }
      ]
    })
    expect(w.commands[0]).toMatchObject({
      description: 'Highlight a line.',
      argDescriptions: { line: '1-based line number' }
    })
  })
})

describe('packWindowSchema · 3d readCaseFiles permission', () => {
  it('accepts readCaseFiles', () => {
    const parsed = packWindowSchema.parse({
      id: 'pg', kind: 'webPanel', title: 'PG', entry: 'pg/index.html',
      permissions: ['getCaseContext', 'readCaseFiles']
    })
    expect(parsed.permissions).toContain('readCaseFiles')
  })
})
