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
})
