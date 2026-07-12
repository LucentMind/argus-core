import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { installPack } from '../install'
import { PacksStateStore } from '../packsState'
import { describeHost } from '../compat'
import { ensurePacksDir } from '../paths'
import { PackRegistry } from '../registry'
import { BinariesService } from '../binaries'

let home: string
let state: PacksStateStore
const bundleDirs: string[] = []
const HOST = { platform: process.platform, arch: process.arch }
const isWin = process.platform === 'win32'
const DEMO = isWin ? 'argus-demo.exe' : 'argus-demo'

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-'))
  state = new PacksStateStore(home)
})
afterEach(() => {
  state.close()
  fs.rmSync(home, { recursive: true, force: true })
  for (const dir of bundleDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Assemble a real host-arch bundle dir: manifest + bin/<host node copy> + valid CHECKSUMS. */
function makeSampleBundle(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-bundle-'))
  bundleDirs.push(dir)
  const manifest = {
    id: 'sample',
    displayName: 'Sample',
    version: '1.0.0',
    argusApi: '^1',
    platform: describeHost(HOST),
    binaries: [
      {
        id: 'argus-demo',
        kind: 'exe',
        displayName: 'Demo',
        names: ['argus-demo'],
        versionArgs: ['--version']
      }
    ]
  }
  fs.writeFileSync(path.join(dir, 'argus-pack.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.mkdirSync(path.join(dir, 'bin'))
  const demo = path.join(dir, 'bin', DEMO)
  fs.copyFileSync(process.execPath, demo) // real host-arch executable
  if (!isWin) fs.chmodSync(demo, 0o755)

  const rels: string[] = []
  const walk = (rel: string): void => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const c = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(c)
      else if (ent.isFile() && c !== 'CHECKSUMS') rels.push(c)
    }
  }
  walk('')
  rels.sort()
  fs.writeFileSync(
    path.join(dir, 'CHECKSUMS'),
    rels
      .map(
        (rel) =>
          `${crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(dir, ...rel.split('/'))))
            .digest('hex')}  ${rel}\n`
      )
      .join('')
  )
  return dir
}

describe('install → verify → load → resolve → spawn (host-arch sample bundle)', () => {
  it('installs the bundle and its binary resolves from pack-bundle and spawns', async () => {
    const r = await installPack(makeSampleBundle(), { argusHome: home, state, host: HOST })
    expect(r.ok).toBe(true)

    // load the freshly installed pack (empty seed dir + the writable install dir)
    const emptySeed = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-seed-'))
    const registry = PackRegistry.load([emptySeed, ensurePacksDir(home)])
    expect(registry.packs().map((p) => p.id)).toContain('sample')

    const binaries = new BinariesService({ registry, settingsTools: () => ({}), capturedEnv: {} })
    const resolved = binaries.get('argus-demo')
    expect(resolved?.source).toBe('pack-bundle')
    expect(resolved?.value).toBe(path.join(ensurePacksDir(home), 'sample', 'bin', DEMO))

    // real spawn: the version probe runs the installed binary
    const rows = await binaries.probe()
    const demoRow = rows.find((row) => row.id === 'argus-demo')
    expect(demoRow?.ok).toBe(true)
    expect(demoRow?.chip).toMatch(/found · /)

    fs.rmSync(emptySeed, { recursive: true, force: true })
  })
})
