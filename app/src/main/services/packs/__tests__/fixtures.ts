import { PackRegistry } from '../registry'
import { packManifestSchema } from '../manifest'
import type { LoadedPack } from '../loader'

/** sample pack's detector declarations (spec Part 1d) — ported from detect.test.ts. */
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

/** A PackRegistry seeded with just the sample pack's detectors, for tests that assert domain types. */
export function samplePackRegistry(): PackRegistry {
  const manifest = packManifestSchema.parse({
    id: 'sample',
    displayName: 'Nav',
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
    referencesDir: null
  }
  return new PackRegistry([pack])
}
