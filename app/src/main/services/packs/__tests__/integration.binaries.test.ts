import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { loadPacks } from '../loader'

describe('sample pack binaries (real manifest)', () => {
  it('declares sample-parse (exe) and sample-trace (pathDir) with legacy settings keys', () => {
    const repoPacks = path.resolve(process.cwd(), '..', 'packs')
    const { packs, errors } = loadPacks(repoPacks)
    expect(errors).toEqual([])
    const nav = packs.find((p) => p.id === 'sample')
    expect(nav).toBeDefined()
    const bins = nav!.manifest.binaries
    expect(bins.map((b) => [b.id, b.kind, b.settingsKey])).toEqual([
      ['sample-parse', 'exe', 'parseBin'],
      ['sample-trace', 'pathDir', 'traceDir']
    ])
    expect(bins[0].envVar).toBe('ARGUS_PARSE_BIN')
    expect(bins[1].doctor).toMatchObject({ cmd: 'sample-trace', json: true })
    // dev path geometry: pack-relative ../../trace-rs lands at the repo root
    expect(path.resolve(nav!.dir, bins[0].devPaths[0])).toBe(
      path.resolve(process.cwd(), '..', 'trace-rs', 'target', 'release')
    )
  })

  it('declares the six navigation detectors with extract commands wired to declared binaries', () => {
    const repoPacks = path.resolve(process.cwd(), '..', 'packs')
    const { packs } = loadPacks(repoPacks)
    const nav = packs.find((p) => p.id === 'sample')!
    const det = nav.manifest.detectors
    expect(det.map((d) => d.type)).toEqual([
      'binlog',
      'archive-rec',
      'bintrace',
      'tagged-json',
      'list-json',
      'applog'
    ])
    const binIds = nav.manifest.binaries.map((b) => b.id)
    for (const d of det) {
      if (d.extract) expect(binIds).toContain(d.extract.bin)
    }
    expect(det.find((d) => d.type === 'applog')?.isText).toBe(true)
    expect(det.find((d) => d.type === 'binlog')?.analyzeSkill).toBe('analyze-binlog')
  })
})
