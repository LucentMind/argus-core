import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveBinary, BinariesService } from '../binaries'
import { PackRegistry } from '../registry'
import { packManifestSchema } from '../manifest'
import type { PackBinary } from '../manifest'
import type { LoadedPack } from '../loader'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bin-'))
})

function exeDecl(over: Partial<PackBinary> = {}): PackBinary {
  return {
    id: 'fake-parse',
    kind: 'exe',
    displayName: 'Fake parse',
    description: '',
    names: ['fake-parse'],
    devPaths: ['bin-out'],
    fixHint: '',
    ...over
  } as PackBinary
}

function mkExe(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name)
  fs.writeFileSync(p, '')
  return p
}

describe('resolveBinary (exe)', () => {
  it('captured env wins when it exists', () => {
    const envBin = mkExe(path.join(tmp, 'env'), 'fake-parse')
    const r = resolveBinary(exeDecl(), {
      packDir: tmp,
      envValue: envBin,
      settingsValue: undefined
    })
    expect(r).toMatchObject({ value: envBin, source: 'env' })
  })

  it('settings beats dev path; missing env is skipped', () => {
    mkExe(path.join(tmp, 'bin-out'), 'fake-parse')
    const settingsBin = mkExe(path.join(tmp, 'settings'), 'fake-parse')
    const r = resolveBinary(exeDecl(), {
      packDir: tmp,
      envValue: path.join(tmp, 'missing.exe'),
      settingsValue: settingsBin
    })
    expect(r).toMatchObject({ value: settingsBin, source: 'settings' })
  })

  it('falls back to devPaths relative to the pack dir', () => {
    const dev = mkExe(path.join(tmp, 'bin-out'), 'fake-parse')
    const r = resolveBinary(exeDecl(), { packDir: tmp, envValue: null, settingsValue: undefined })
    expect(r).toMatchObject({ value: dev, source: 'pack-dev' })
  })

  it('resolves the installed bundle bin/ before devPaths', () => {
    const bundled = mkExe(path.join(tmp, 'bin'), 'fake-parse') // <packDir>/bin
    mkExe(path.join(tmp, 'bin-out'), 'fake-parse') // devPaths — must lose to the bundle
    const r = resolveBinary(exeDecl(), { packDir: tmp, envValue: null, settingsValue: undefined })
    expect(r).toMatchObject({ value: bundled, source: 'pack-bundle' })
  })

  it('returns null when nothing is found and no pathProbeArgs', () => {
    const r = resolveBinary(exeDecl(), { packDir: tmp, envValue: null, settingsValue: undefined })
    expect(r).toMatchObject({ value: null, source: null })
  })
})

describe('resolveBinary (pathDir)', () => {
  function dirDecl(): PackBinary {
    return {
      id: 'fake-trace',
      kind: 'pathDir',
      displayName: 'Fake trace',
      description: '',
      names: ['fake-trace'],
      devPaths: [path.join('venv', '{platformBin}')],
      fixHint: ''
    } as PackBinary
  }

  it('resolves {platformBin} against the pack dir', () => {
    const plat = process.platform === 'win32' ? 'Scripts' : 'bin'
    const dev = path.join(tmp, 'venv', plat)
    fs.mkdirSync(dev, { recursive: true })
    const r = resolveBinary(dirDecl(), { packDir: tmp, envValue: null, settingsValue: undefined })
    expect(r).toMatchObject({ value: dev, source: 'pack-dev' })
  })

  it('resolves to bundle bin/ when it holds the executable', () => {
    mkExe(path.join(tmp, 'bin'), 'fake-trace')
    const r = resolveBinary(dirDecl(), { packDir: tmp, envValue: null, settingsValue: undefined })
    expect(r).toMatchObject({ value: path.join(tmp, 'bin'), source: 'pack-bundle' })
  })

  it('env dir wins; null when nothing exists (no PATH probe for dirs)', () => {
    const envDir = path.join(tmp, 'env-dir')
    fs.mkdirSync(envDir, { recursive: true })
    expect(
      resolveBinary(dirDecl(), { packDir: tmp, envValue: envDir, settingsValue: undefined })
    ).toMatchObject({ value: envDir, source: 'env' })
    expect(
      resolveBinary(dirDecl(), {
        packDir: path.join(tmp, 'nope'),
        envValue: null,
        settingsValue: undefined
      })
    ).toMatchObject({ value: null, source: null })
  })
})

function packWith(binaries: unknown[], dir: string): LoadedPack {
  const manifest = packManifestSchema.parse({
    id: 'testpack',
    displayName: 'T',
    version: '1',
    argusApi: '^1',
    binaries
  })
  return { id: 'testpack', dir, manifest, personaText: null, skillsDir: null, referencesDir: null }
}

describe('BinariesService', () => {
  it('resolves from captured env, ignoring live (app-exported) process.env', () => {
    const userSet = undefined // user did NOT set FAKE_BIN
    const settingsBin = mkExe(path.join(tmp, 's'), 'fake-parse')
    process.env.FAKE_BIN = mkExe(path.join(tmp, 'app-exported'), 'fake-parse') // app export, must NOT win
    try {
      const svc = new BinariesService({
        registry: new PackRegistry([
          packWith(
            [
              {
                id: 'fake-parse',
                kind: 'exe',
                displayName: 'F',
                names: ['fake-parse'],
                envVar: 'FAKE_BIN',
                settingsKey: 'parseBin'
              }
            ],
            tmp
          )
        ]),
        settingsTools: () => ({ parseBin: settingsBin }),
        capturedEnv: { FAKE_BIN: userSet }
      })
      expect(svc.get('fake-parse')).toMatchObject({ value: settingsBin, source: 'settings' })
    } finally {
      delete process.env.FAKE_BIN
    }
  })

  it('exports envVar for children only when the user did not set it', () => {
    const dev = mkExe(path.join(tmp, 'bin-out'), 'fake-parse')
    delete process.env.FAKE_BIN
    new BinariesService({
      registry: new PackRegistry([
        packWith(
          [
            {
              id: 'fake-parse',
              kind: 'exe',
              displayName: 'F',
              names: ['fake-parse'],
              envVar: 'FAKE_BIN',
              devPaths: ['bin-out']
            }
          ],
          tmp
        )
      ]),
      settingsTools: () => ({}),
      capturedEnv: { FAKE_BIN: undefined }
    })
    expect(process.env.FAKE_BIN).toBe(dev) // exported for spawned children
    const userBin = mkExe(path.join(tmp, 'user'), 'fake-parse')
    const svc2 = new BinariesService({
      registry: new PackRegistry([
        packWith(
          [
            {
              id: 'fake-parse',
              kind: 'exe',
              displayName: 'F',
              names: ['fake-parse'],
              envVar: 'FAKE_BIN',
              devPaths: ['bin-out']
            }
          ],
          tmp
        )
      ]),
      settingsTools: () => ({}),
      capturedEnv: { FAKE_BIN: userBin }
    })
    expect(svc2.get('fake-parse')?.source).toBe('env')
    expect(process.env.FAKE_BIN).toBe(userBin) // never clobbered
    delete process.env.FAKE_BIN
  })

  it('prepends a resolved pathDir to PATH exactly once', () => {
    const plat = process.platform === 'win32' ? 'Scripts' : 'bin'
    const dir = path.join(tmp, 'venv', plat)
    fs.mkdirSync(dir, { recursive: true })
    const before = process.env.PATH ?? ''
    try {
      const deps = {
        registry: new PackRegistry([
          packWith(
            [
              {
                id: 'fake-trace',
                kind: 'pathDir',
                displayName: 'T',
                names: ['fake-trace'],
                devPaths: [path.join('venv', '{platformBin}')]
              }
            ],
            tmp
          )
        ]),
        settingsTools: () => ({}),
        capturedEnv: {}
      }
      const svc = new BinariesService(deps)
      expect((process.env.PATH ?? '').split(path.delimiter)[0]).toBe(dir)
      svc.recompute() // idempotent
      const segs = (process.env.PATH ?? '').split(path.delimiter).filter((s) => s === dir)
      expect(segs).toHaveLength(1)
    } finally {
      process.env.PATH = before
    }
  })

  it('skips binaries declared for other platforms', () => {
    const other = process.platform === 'win32' ? 'linux' : 'win32'
    const svc = new BinariesService({
      registry: new PackRegistry([
        packWith(
          [
            {
              id: 'other-only',
              kind: 'exe',
              displayName: 'O',
              names: ['other-only'],
              platforms: [other]
            }
          ],
          tmp
        )
      ]),
      settingsTools: () => ({}),
      capturedEnv: {}
    })
    expect(svc.all()).toHaveLength(0)
    expect(svc.get('other-only')).toBeUndefined()
  })

  it('settingsRows reflects settings value + 3-way source', () => {
    const svc = new BinariesService({
      registry: new PackRegistry([
        packWith(
          [
            {
              id: 'fake-parse',
              kind: 'exe',
              displayName: 'Fake parse',
              description: 'desc',
              names: ['fake-parse'],
              envVar: 'FAKE_BIN',
              settingsKey: 'parseBin'
            }
          ],
          tmp
        )
      ]),
      settingsTools: () => ({ parseBin: '' }),
      capturedEnv: { FAKE_BIN: undefined }
    })
    expect(svc.settingsRows()).toEqual([
      {
        id: 'fake-parse',
        displayName: 'Fake parse',
        description: 'desc',
        kind: 'exe',
        envVar: 'FAKE_BIN',
        settingsKey: 'parseBin',
        settingsValue: '',
        value: null,
        source: 'default'
      }
    ])
  })

  it('probe reports not-found and found-in-dir for pathDir', async () => {
    const plat = process.platform === 'win32' ? 'Scripts' : 'bin'
    const dir = path.join(tmp, 'venv', plat)
    mkExe(dir, 'fake-trace')
    const before = process.env.PATH ?? ''
    try {
      const svc = new BinariesService({
        registry: new PackRegistry([
          packWith(
            [
              { id: 'gone', kind: 'exe', displayName: 'G', names: ['gone-bin'] },
              {
                id: 'fake-trace',
                kind: 'pathDir',
                displayName: 'T',
                names: ['fake-trace'],
                devPaths: [path.join('venv', '{platformBin}')]
              }
            ],
            tmp
          )
        ]),
        settingsTools: () => ({}),
        capturedEnv: {}
      })
      const rows = await svc.probe()
      expect(rows.find((r) => r.id === 'gone')).toMatchObject({ ok: false, chip: 'not found' })
      expect(rows.find((r) => r.id === 'fake-trace')).toMatchObject({ ok: true, chip: 'found' })
    } finally {
      process.env.PATH = before
    }
  })

  it('preflight aggregates exe existence + json doctor checks in decl order', async () => {
    const dev = mkExe(path.join(tmp, 'bin-out'), 'fake-parse')
    const svc = new BinariesService({
      registry: new PackRegistry([
        packWith(
          [
            {
              id: 'fake-parse',
              kind: 'exe',
              displayName: 'F',
              names: ['fake-parse'],
              devPaths: ['bin-out']
            },
            {
              id: 'fake-trace',
              kind: 'pathDir',
              displayName: 'T',
              names: ['fake-trace'],
              doctor: {
                cmd: process.execPath,
                args: [
                  '-e',
                  'console.log(JSON.stringify({ok:true,checks:[{name:"venv",ok:true,detail:"3.11"}]}))'
                ],
                json: true
              }
            }
          ],
          tmp
        )
      ]),
      settingsTools: () => ({}),
      capturedEnv: {}
    })
    const rep = await svc.preflight()
    expect(rep.ok).toBe(true)
    expect(rep.checks[0]).toMatchObject({ name: 'fake-parse', ok: true, detail: dev })
    expect(rep.checks[1]).toMatchObject({ name: 'venv', ok: true })
  })

  it('preflight reports a missing doctor command as a failed check with the fixHint', async () => {
    const svc = new BinariesService({
      registry: new PackRegistry([
        packWith(
          [
            {
              id: 'fake-trace',
              kind: 'pathDir',
              displayName: 'T',
              names: ['fake-trace'],
              doctor: { cmd: 'definitely-not-a-command-xyz', args: [], json: false },
              fixHint: 'install the venv'
            }
          ],
          tmp
        )
      ]),
      settingsTools: () => ({}),
      capturedEnv: {}
    })
    const rep = await svc.preflight()
    expect(rep.ok).toBe(false)
    expect(rep.checks[0].ok).toBe(false)
    expect(rep.checks[0].detail).toContain('install the venv')
  })

  it('preflight dedupes checks by name, keeping the first occurrence', async () => {
    const dev = mkExe(path.join(tmp, 'bin-out'), 'fake-parse')
    const svc = new BinariesService({
      registry: new PackRegistry([packWith([
        { id: 'fake-parse', kind: 'exe', displayName: 'F', names: ['fake-parse'], devPaths: ['bin-out'] },
        { id: 'fake-trace', kind: 'pathDir', displayName: 'T', names: ['fake-trace'],
          doctor: { cmd: process.execPath,
            args: ['-e', 'console.log(JSON.stringify({ok:true,checks:[{name:"fake-parse",ok:false,detail:"doctor dup"},{name:"venv",ok:true,detail:"3.11"}]}))'],
            json: true } }
      ], tmp)]),
      settingsTools: () => ({}),
      capturedEnv: {}
    })
    const rep = await svc.preflight()
    const parseChecks = rep.checks.filter((c) => c.name === 'fake-parse')
    expect(parseChecks).toHaveLength(1)
    expect(parseChecks[0]).toMatchObject({ ok: true, detail: dev }) // exe check won, doctor's dup dropped
    expect(rep.ok).toBe(true) // the dropped failing dup no longer poisons the aggregate
  })
})
