import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listInstalledPacks } from '../packsService'
import { PacksStateStore } from '../packsState'
import { PackRegistry } from '../registry'
import { BinariesService } from '../binaries'
import { packManifestSchema } from '../manifest'
import type { LoadedPack } from '../loader'

function lp(id: string, version: string, dir: string, binaries: unknown[] = []): LoadedPack {
  return {
    id,
    dir,
    manifest: packManifestSchema.parse({
      id,
      displayName: id.toUpperCase(),
      version,
      argusApi: '^1',
      platform: 'win-x64',
      binaries
    }),
    personaText: null,
    skillsDir: null,
    referencesDir: null,
    uiDir: null
  }
}

let home: string
let state: PacksStateStore
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-psvc-'))
  state = new PacksStateStore(home)
})
afterEach(() => {
  state.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('listInstalledPacks', () => {
  it('merges state + registry and reports per-binary health', async () => {
    const dir = path.join(home, 'packs', 'sample')
    const registry = new PackRegistry([
      lp('sample', '1.0.0', dir, [
        { id: 'argus-demo', kind: 'exe', displayName: 'Demo', names: ['argus-demo'] }
      ])
    ])
    state.set('sample', '1.0.0')
    const binaries = new BinariesService({ registry, settingsTools: () => ({}), capturedEnv: {} })
    const { packs } = await listInstalledPacks({ state, registry, binaries })
    const row = packs.find((p) => p.id === 'sample')!
    expect(row).toMatchObject({
      id: 'sample',
      displayName: 'SAMPLE',
      installedVersion: '1.0.0',
      loadedVersion: '1.0.0',
      platform: 'win-x64',
      pendingRelaunch: false
    })
    expect(row.binaries[0]).toMatchObject({ id: 'argus-demo', ok: false }) // no file on disk → not found
  })

  it('flags pendingRelaunch when installed version differs from loaded', async () => {
    const registry = new PackRegistry([lp('sample', '1.0.0', path.join(home, 'x'))])
    state.set('sample', '2.0.0') // installed newer than the loaded manifest
    const binaries = new BinariesService({ registry, settingsTools: () => ({}), capturedEnv: {} })
    const { packs } = await listInstalledPacks({ state, registry, binaries })
    expect(packs.find((p) => p.id === 'sample')).toMatchObject({
      installedVersion: '2.0.0',
      loadedVersion: '1.0.0',
      pendingRelaunch: true
    })
  })

  it('includes a loaded bundled pack absent from state (installedVersion null)', async () => {
    const registry = new PackRegistry([lp('code-graph', '0.1.0', path.join(home, 'cg'))])
    const binaries = new BinariesService({ registry, settingsTools: () => ({}), capturedEnv: {} })
    const { packs } = await listInstalledPacks({ state, registry, binaries })
    expect(packs.find((p) => p.id === 'code-graph')).toMatchObject({
      installedVersion: null,
      loadedVersion: '0.1.0',
      pendingRelaunch: false
    })
  })
})

describe('relaunchRequired / touched', () => {
  const binariesFor = (registry: PackRegistry): BinariesService =>
    new BinariesService({ registry, settingsTools: () => ({}), capturedEnv: {} })

  it('is false on a settled boot', async () => {
    const registry = new PackRegistry([lp('sample', '1.0.0', path.join(home, 'x'))])
    state.set('sample', '1.0.0')
    const payload = await listInstalledPacks({ state, registry, binaries: binariesFor(registry) })
    expect(payload.relaunchRequired).toBe(false)
  })

  it('flags a same-version reinstall, which the version comparison cannot see', async () => {
    // The reported bug: reinstalling 1.1 over 1.1 leaves installedVersion === loadedVersion, so
    // the old comparison reported "settled" while the bytes on disk had in fact been replaced.
    const registry = new PackRegistry([lp('sample', '1.1.0', path.join(home, 'x'))])
    state.set('sample', '1.1.0')
    const payload = await listInstalledPacks({
      state,
      registry,
      binaries: binariesFor(registry),
      touched: new Set(['sample'])
    })
    expect(payload.packs.find((p) => p.id === 'sample')).toMatchObject({
      installedVersion: '1.1.0',
      loadedVersion: '1.1.0',
      pendingRelaunch: true
    })
    expect(payload.relaunchRequired).toBe(true)
  })

  it('flags an uninstall, whose row drops installedVersion to null', async () => {
    // uninstallPack removes the state entry but the pack stays loaded until relaunch, so the
    // comparison's `installedVersion != null` guard short-circuits to "settled".
    const registry = new PackRegistry([lp('sample', '1.0.0', path.join(home, 'x'))])
    const payload = await listInstalledPacks({
      state,
      registry,
      binaries: binariesFor(registry),
      touched: new Set(['sample'])
    })
    expect(payload.packs.find((p) => p.id === 'sample')).toMatchObject({
      installedVersion: null,
      loadedVersion: '1.0.0',
      pendingRelaunch: true
    })
    expect(payload.relaunchRequired).toBe(true)
  })

  it('flags a touched pack that has no row at all', async () => {
    // Uninstalling a pack that never loaded leaves nothing in state and nothing in the registry,
    // so no row survives to carry pendingRelaunch.
    const registry = new PackRegistry([])
    const payload = await listInstalledPacks({
      state,
      registry,
      binaries: binariesFor(registry),
      touched: new Set(['ghost'])
    })
    expect(payload.packs).toHaveLength(0)
    expect(payload.relaunchRequired).toBe(true)
  })

  it('leaves untouched packs settled while a touched sibling flags', async () => {
    const registry = new PackRegistry([lp('alpha', '1.0.0', '/a'), lp('beta', '1.0.0', '/b')])
    state.set('alpha', '1.0.0')
    state.set('beta', '1.0.0')
    const payload = await listInstalledPacks({
      state,
      registry,
      binaries: binariesFor(registry),
      touched: new Set(['alpha'])
    })
    const byId = Object.fromEntries(payload.packs.map((p) => [p.id, p]))
    expect(byId.alpha.pendingRelaunch).toBe(true)
    expect(byId.beta.pendingRelaunch).toBe(false)
    expect(payload.relaunchRequired).toBe(true)
  })

  it('still flags a version mismatch with no touched set (the pre-existing signal)', async () => {
    const registry = new PackRegistry([lp('sample', '1.0.0', path.join(home, 'x'))])
    state.set('sample', '2.0.0')
    const payload = await listInstalledPacks({ state, registry, binaries: binariesFor(registry) })
    expect(payload.relaunchRequired).toBe(true)
  })
})

describe('update status on rows', () => {
  it('attaches a status to the matching pack and null to the rest', async () => {
    const registry = new PackRegistry([lp('alpha', '1.0.0', '/a'), lp('beta', '1.0.0', '/b')])
    state.set('alpha', '1.0.0')
    state.set('beta', '1.0.0')
    const binaries = new BinariesService({ registry, settingsTools: () => ({}), capturedEnv: {} })
    const payload = await listInstalledPacks({
      state,
      registry,
      binaries,
      updates: { alpha: { phase: 'available', version: '1.1.0' } }
    })
    const byId = Object.fromEntries(payload.packs.map((p) => [p.id, p]))
    expect(byId.alpha.update).toEqual({ phase: 'available', version: '1.1.0' })
    expect(byId.beta.update).toBeNull()
  })

  it('defaults every row to null when no statuses are supplied', async () => {
    const registry = new PackRegistry([lp('alpha', '1.0.0', '/a')])
    state.set('alpha', '1.0.0')
    const binaries = new BinariesService({ registry, settingsTools: () => ({}), capturedEnv: {} })
    const payload = await listInstalledPacks({ state, registry, binaries })
    expect(payload.packs[0].update).toBeNull()
  })
})
