import { PackRegistry } from '../registry'
import { packManifestSchema } from '../manifest'
import type { LoadedPack } from '../loader'
import { BinariesService } from '../binaries'
import { createExtractors, type Extractors } from '../extractors'

/** App Pack's detector declarations (spec Part 1d) — ported from detect.test.ts. */
export const SAMPLE_DETECTORS = [
  {
    type: 'binlog',
    displayName: 'Binary log',
    analyzeSkill: 'analyze-binlog',
    match: [{ magicHex: '444C5401' }, { nameEndsWith: ['.binlog'] }],
    extract: { bin: 'sample-parse', args: ['binlog-to-text', '{input}', '--output', '{output}'] }
  },
  {
    type: 'archive-rec',
    analyzeSkill: 'analyze-archive-rec',
    match: [{ magicHex: '1F8B', nameEndsWith: ['.rec.gz'] }]
  },
  {
    type: 'bintrace',
    match: [{ nameEndsWith: ['.bintrace', '.bintrace.zip'] }],
    extract: {
      bin: 'sample-trace',
      args: ['convert-bintrace-to-text', '{input}', '--output', '{output}']
    }
  },
  {
    type: 'tagged-json',
    analyzeSkill: 'analyze-tagged-json',
    isText: true,
    match: [
      { nameEndsWith: ['.json'], nameContains: ['tagged'], json: {} },
      { nameEndsWith: ['.json'], json: { anyKeys: ['tagged', 'tagged_events'] } }
    ]
  },
  {
    type: 'list-json',
    isText: true,
    match: [
      { nameEndsWith: ['.list.json'] },
      { nameEndsWith: ['.json'], json: { arrayKeys: ['events'] } }
    ]
  },
  {
    type: 'applog',
    analyzeSkill: 'analyze-applog',
    isText: true,
    match: [
      {
        headRegex: {
          source: '^\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d+\\s+\\d+\\s+\\d+\\s+[VDIWEF]\\s',
          flags: 'm'
        }
      },
      { headRegex: { source: '--------- beginning of' } }
    ]
  }
]

/** A PackRegistry seeded with just the App Pack's detectors, for tests that assert domain types. */
export function samplePackRegistry(): PackRegistry {
  const manifest = packManifestSchema.parse({
    id: 'sample',
    displayName: 'App',
    version: '1',
    argusApi: '^1',
    detectors: SAMPLE_DETECTORS
  })
  const pack: LoadedPack = {
    id: 'sample',
    dir: '/packs/sample',
    manifest,
    personaText: null,
    skillsDir: null,
    referencesDir: null,
    uiDir: null
  }
  return new PackRegistry([pack])
}

/** Minimal single-pack registry for tests needing custom binaries + detectors (e.g. extraction stubs). */
export function testRegistry(binaries: unknown[], detectors: unknown[]): PackRegistry {
  const manifest = packManifestSchema.parse({
    id: 'testpack',
    displayName: 'T',
    version: '1',
    argusApi: '^1',
    binaries,
    detectors
  })
  const pack: LoadedPack = {
    id: 'testpack',
    dir: '/packs/testpack',
    manifest,
    personaText: null,
    skillsDir: null,
    referencesDir: null,
    uiDir: null
  }
  return new PackRegistry([pack])
}

/** Inline-JS extract command that copies {input} → {output} verbatim (node itself as the 'binary'). */
export const COPY_EXTRACT_ARGS = [
  '-e',
  'const fs=require("fs");fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1]))',
  '{input}',
  '{output}'
]

/**
 * Extractors resolving `type` (files named `*.binlog`) to a stub 'binary', captured via envVar so
 * resolution wins over any devPaths/settings. Default: process.execPath running a copy-input-to-
 * output inline script, exercising the real extraction pipeline without a real pack binary — no
 * copying node.exe. Pass `binPath`/`args` to point at a custom stub (e.g. a .bat/.sh script) instead.
 * When resolves=false the declared binary intentionally doesn't resolve (extractFor → null): the
 * old argusParse:null case.
 */
export function stubExtractors(
  type: string,
  opts: { resolves?: boolean; binPath?: string; args?: string[] } = {}
): Extractors {
  const { resolves = true, binPath, args = COPY_EXTRACT_ARGS } = opts
  const envVar = 'ARGUS_TEST_STUB_BIN'
  const reg = testRegistry(
    [{ id: 'stub', kind: 'exe', displayName: 'Stub', names: ['stub'], envVar }],
    [{ type, match: [{ nameEndsWith: ['.binlog'] }], extract: { bin: 'stub', args } }]
  )
  const svc = new BinariesService({
    registry: reg,
    settingsTools: () => ({}),
    capturedEnv: { [envVar]: binPath ?? (resolves ? process.execPath : undefined) }
  })
  return createExtractors(reg, svc)
}
