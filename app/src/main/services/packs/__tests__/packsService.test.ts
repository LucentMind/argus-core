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
    referencesDir: null
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
