import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PackRegistry } from '../registry'

let root: string

function writePack(dir: string, id: string, extra: object = {}): void {
  const packDir = path.join(dir, id)
  fs.mkdirSync(packDir, { recursive: true })
  fs.writeFileSync(
    path.join(packDir, 'argus-pack.json'),
    JSON.stringify({ id, displayName: id, version: '1.0.0', argusApi: '^1', ...extra })
  )
}

function binary(id: string): object {
  return { id, kind: 'exe', displayName: id, names: [id], devPaths: [] }
}

function detector(type: string): object {
  return { type, match: [{ nameEndsWith: [`.${type}`] }] }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-deporder-'))
})

describe('dependency-ordered load', () => {
  it('places a dependency before its dependent regardless of id sort order', () => {
    writePack(root, 'maps', { dependencies: { common: '^1' } })
    writePack(root, 'common')
    const reg = PackRegistry.load(root)
    expect(reg.errors()).toEqual([])
    expect(reg.packs().map((p) => p.id)).toEqual(['common', 'maps'])
  })

  it('sorts by id among packs with no dependency relation', () => {
    writePack(root, 'zeta')
    writePack(root, 'alpha')
    writePack(root, 'mid')
    expect(
      PackRegistry.load(root)
        .packs()
        .map((p) => p.id)
    ).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('orders a transitive chain dependency-first', () => {
    writePack(root, 'alpha', { dependencies: { zeta: '^1' } })
    writePack(root, 'zeta', { dependencies: { mid: '^1' } })
    writePack(root, 'mid')
    expect(
      PackRegistry.load(root)
        .packs()
        .map((p) => p.id)
    ).toEqual(['mid', 'zeta', 'alpha'])
  })

  it('resolves a dependency living in a different packs dir', () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'))
    const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'))
    writePack(seed, 'common')
    writePack(installed, 'maps', { dependencies: { common: '^1' } })
    const reg = PackRegistry.load([seed, installed])
    expect(reg.errors()).toEqual([])
    expect(reg.packs().map((p) => p.id)).toEqual(['common', 'maps'])
  })
})

describe('missing dependencies', () => {
  it('excludes a pack whose declared dependency is absent and records an error', () => {
    writePack(root, 'maps', { dependencies: { common: '^1.2' } })
    const reg = PackRegistry.load(root)
    expect(reg.packs().map((p) => p.id)).toEqual([])
    expect(reg.errors()).toHaveLength(1)
    const msg = reg.errors()[0].message
    expect(msg).toContain('maps')
    expect(msg).toContain('common')
    expect(msg).toContain('^1.2')
    expect(reg.errors()[0].dir).toBe(path.join(root, 'maps'))
  })

  it('cascades: a pack depending on a pack that failed to load also errors', () => {
    writePack(root, 'top', { dependencies: { maps: '^1' } })
    writePack(root, 'maps', { dependencies: { common: '^1' } })
    const reg = PackRegistry.load(root)
    expect(reg.packs()).toEqual([])
    expect(
      reg
        .errors()
        .map((e) => e.dir)
        .sort()
    ).toEqual([path.join(root, 'maps'), path.join(root, 'top')].sort())
  })

  it('leaves unrelated packs loadable when one pack has a missing dependency', () => {
    writePack(root, 'maps', { dependencies: { common: '^1' } })
    writePack(root, 'standalone')
    const reg = PackRegistry.load(root)
    expect(reg.packs().map((p) => p.id)).toEqual(['standalone'])
    expect(reg.errors()).toHaveLength(1)
  })
})

describe('cross-pack id collisions', () => {
  it('errors both packs when two declare the same binary id', () => {
    writePack(root, 'navigation', { binaries: [binary('navnative-trace')] })
    writePack(root, 'maps', { binaries: [binary('navnative-trace')] })
    const reg = PackRegistry.load(root)
    expect(reg.packs()).toEqual([])
    expect(reg.binaryDecls()).toEqual([])
    expect(reg.errors()).toHaveLength(2)
    for (const e of reg.errors()) {
      expect(e.message).toContain('navnative-trace')
      expect(e.message).toContain('maps')
      expect(e.message).toContain('navigation')
    }
  })

  it('errors both packs when two declare the same detector type', () => {
    writePack(root, 'navigation', { detectors: [detector('logcat')] })
    writePack(root, 'maps', { detectors: [detector('logcat')] })
    const reg = PackRegistry.load(root)
    expect(reg.packs()).toEqual([])
    expect(reg.detectorDecls()).toEqual([])
    expect(reg.errors()).toHaveLength(2)
    for (const e of reg.errors()) {
      expect(e.message).toContain('logcat')
      expect(e.message).toContain('maps')
      expect(e.message).toContain('navigation')
    }
  })

  it('a pack depending on a collided pack is excluded too', () => {
    writePack(root, 'navigation', { binaries: [binary('shared-tool')] })
    writePack(root, 'maps', { binaries: [binary('shared-tool')] })
    writePack(root, 'top', { dependencies: { maps: '^1' } })
    const reg = PackRegistry.load(root)
    expect(reg.packs()).toEqual([])
    expect(reg.errors()).toHaveLength(3)
  })

  it('distinct ids across packs load normally', () => {
    writePack(root, 'navigation', { binaries: [binary('nav-tool')], detectors: [detector('dlt')] })
    writePack(root, 'maps', { binaries: [binary('map-tool')], detectors: [detector('style')] })
    const reg = PackRegistry.load(root)
    expect(reg.errors()).toEqual([])
    expect(
      reg
        .binaryDecls()
        .map((d) => d.decl.id)
        .sort()
    ).toEqual(['map-tool', 'nav-tool'])
    expect(
      reg
        .detectorDecls()
        .map((d) => d.type)
        .sort()
    ).toEqual(['dlt', 'style'])
  })
})

describe('dependency cycles', () => {
  it('errors both packs in a two-pack cycle instead of loading them in arbitrary order', () => {
    writePack(root, 'alpha', { dependencies: { beta: '^1' } })
    writePack(root, 'beta', { dependencies: { alpha: '^1' } })
    const reg = PackRegistry.load(root)
    expect(reg.packs()).toEqual([])
    expect(reg.errors()).toHaveLength(2)
    for (const e of reg.errors()) expect(e.message).toMatch(/cycle/i)
  })

  it('errors a self-dependency', () => {
    writePack(root, 'alpha', { dependencies: { alpha: '^1' } })
    const reg = PackRegistry.load(root)
    expect(reg.packs()).toEqual([])
    expect(reg.errors()).toHaveLength(1)
    expect(reg.errors()[0].message).toMatch(/cycle/i)
  })

  it('a healthy pack still loads alongside a cycle', () => {
    writePack(root, 'alpha', { dependencies: { beta: '^1' } })
    writePack(root, 'beta', { dependencies: { alpha: '^1' } })
    writePack(root, 'standalone')
    const reg = PackRegistry.load(root)
    expect(reg.packs().map((p) => p.id)).toEqual(['standalone'])
    expect(reg.errors()).toHaveLength(2)
  })
})
