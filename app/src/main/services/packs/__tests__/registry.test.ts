import { describe, it, expect } from 'vitest'
import { PackRegistry } from '../registry'
import { packManifestSchema } from '../manifest'
import type { LoadedPack } from '../loader'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function lp(
  id: string,
  personaText: string | null,
  assets?: { skills?: string; refs?: string }
): LoadedPack {
  return {
    id,
    dir: `/packs/${id}`,
    manifest: packManifestSchema.parse({ id, displayName: id, version: '1', argusApi: '^1' }),
    personaText,
    skillsDir: assets?.skills ?? null,
    referencesDir: assets?.refs ?? null,
    uiDir: null
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
      id: 'alpha',
      displayName: 'A',
      version: '1',
      argusApi: '^1',
      detectors: [{ type: 'binlog', match: [{ nameEndsWith: ['.binlog'] }] }]
    })
    const reg = new PackRegistry([a, lp('beta', null)])
    expect(reg.detectorDecls().map((d) => d.type)).toEqual(['binlog'])
  })

  it('flattens reference-routing rules across packs in pack order', () => {
    const a = lp('alpha', null)
    a.manifest = packManifestSchema.parse({
      id: 'alpha',
      displayName: 'alpha',
      version: '1',
      argusApi: '^1',
      referenceRouting: [{ keywords: ['binlog'], target: 'binlog-protocol.md' }]
    })
    const b = lp('beta', null)
    b.manifest = packManifestSchema.parse({
      id: 'beta',
      displayName: 'beta',
      version: '1',
      argusApi: '^1',
      referenceRouting: [{ keywords: ['tile'], target: 'data-versioning.md' }]
    })
    const reg = new PackRegistry([a, b])
    expect(reg.referenceRouting()).toEqual([
      { keywords: ['binlog'], target: 'binlog-protocol.md' },
      { keywords: ['tile'], target: 'data-versioning.md' }
    ])
  })

  it('is empty when no pack declares reference-routing rules', () => {
    const reg = new PackRegistry([lp('alpha', null), lp('beta', null)])
    expect(reg.referenceRouting()).toEqual([])
  })
})

describe('PackRegistry.load (multi-dir)', () => {
  function writePack(root: string, id: string, extra: object = {}): string {
    const dir = path.join(root, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'argus-pack.json'),
      JSON.stringify({ id, displayName: id, version: '1', argusApi: '^1', ...extra })
    )
    return dir
  }

  it('merges packs from seed then installed, id-sorted', () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'))
    const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'))
    writePack(seed, 'code-graph')
    writePack(installed, 'navigation')
    const reg = PackRegistry.load([seed, installed])
    expect(reg.packs().map((p) => p.id)).toEqual(['code-graph', 'navigation'])
  })

  it('a later dir shadows a same-id pack from an earlier dir (installed wins)', () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'))
    const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'))
    writePack(seed, 'code-graph', { version: '1' })
    writePack(installed, 'code-graph', { version: '2' })
    const reg = PackRegistry.load([seed, installed])
    expect(reg.packs()).toHaveLength(1)
    expect(reg.packs()[0].manifest.version).toBe('2')
    expect(reg.packs()[0].dir).toBe(path.join(installed, 'code-graph'))
  })

  it('scans a dir that appears twice only once (dev: seed === installed)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'both-'))
    writePack(dir, 'code-graph')
    const reg = PackRegistry.load([dir, dir])
    expect(reg.packs().map((p) => p.id)).toEqual(['code-graph'])
  })

  it('a pack-free Core (empty seed + empty installed) loads no packs and no binaries', () => {
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'))
    const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'))
    const reg = PackRegistry.load([seed, installed])
    expect(reg.packs()).toEqual([])
    expect(reg.binaryDecls()).toEqual([])
  })

  it('loads an externalApp pack with no ui/ dir and validates entry under the pack dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'))
    const dir = writePack(root, 'ext-pack', {
      windows: [
        {
          id: 'sim',
          kind: 'externalApp',
          title: 'Sim',
          entry: 'bin/sim.mjs',
          control: { channel: 'stdio' },
          runtime: 'node',
          commands: [{ id: 'ping', risk: 'low', args: [] }]
        }
      ]
    })
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'bin', 'sim.mjs'), '// stub\n')

    const reg = PackRegistry.load(root)
    expect(reg.errors()).toEqual([])
    expect(reg.packs().map((p) => p.id)).toContain('ext-pack')
  })

  it('rejects an externalApp window whose entry is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-missing-'))
    writePack(root, 'ext-missing', {
      windows: [
        {
          id: 'sim',
          kind: 'externalApp',
          title: 'Sim',
          entry: 'bin/nope.mjs',
          control: { channel: 'stdio' }
        }
      ]
    })
    const reg = PackRegistry.load(root)
    expect(reg.errors().some((e) => /entry not found/.test(e.message))).toBe(true)
  })

  it('windowDecls surfaces externalApp windows from packs with no ui/ dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-decls-'))
    const dir = writePack(root, 'ext-pack', {
      windows: [
        {
          id: 'sim',
          kind: 'externalApp',
          title: 'Sim',
          entry: 'bin/sim.mjs',
          control: { channel: 'stdio' },
          runtime: 'node',
          commands: [{ id: 'ping', risk: 'low', args: [] }]
        }
      ]
    })
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'bin', 'sim.mjs'), '// stub\n')

    const reg = PackRegistry.load(root)
    const decls = reg.windowDecls()
    const sim = decls.find((d) => d.packId === 'ext-pack' && d.decl.id === 'sim')
    expect(sim).toBeDefined()
    expect(sim!.decl.kind).toBe('externalApp')
    expect(sim!.uiDir).toBeNull()
  })
})

describe('windowDecls', () => {
  it('flattens webPanel windows across packs with packId/uiDir', () => {
    const a = lp('alpha', null)
    a.uiDir = '/packs/alpha/ui'
    a.manifest = packManifestSchema.parse({
      id: 'alpha',
      displayName: 'alpha',
      version: '1',
      argusApi: '^1',
      windows: [
        {
          id: 'viewer',
          kind: 'webPanel',
          title: 'Viewer',
          entry: 'viewer/index.html',
          handles: ['logcat']
        }
      ]
    })
    const reg = new PackRegistry([a, lp('beta', null)])
    const decls = reg.windowDecls()
    expect(decls).toHaveLength(1)
    expect(decls[0]).toMatchObject({
      packId: 'alpha',
      packDir: '/packs/alpha',
      uiDir: '/packs/alpha/ui'
    })
    expect(decls[0].decl.id).toBe('viewer')
    expect(decls[0].decl.handles).toEqual(['logcat'])
  })

  it('is empty when no pack declares windows', () => {
    expect(new PackRegistry([lp('alpha', null), lp('beta', null)]).windowDecls()).toEqual([])
  })
})
