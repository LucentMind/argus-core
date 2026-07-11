import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveBinary } from '../binaries'
import type { PackBinary } from '../manifest'

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
      packDir: tmp, envValue: envBin, settingsValue: undefined
    })
    expect(r).toMatchObject({ value: envBin, source: 'env' })
  })

  it('settings beats dev path; missing env is skipped', () => {
    mkExe(path.join(tmp, 'bin-out'), 'fake-parse')
    const settingsBin = mkExe(path.join(tmp, 'settings'), 'fake-parse')
    const r = resolveBinary(exeDecl(), {
      packDir: tmp, envValue: path.join(tmp, 'missing.exe'), settingsValue: settingsBin
    })
    expect(r).toMatchObject({ value: settingsBin, source: 'settings' })
  })

  it('falls back to devPaths relative to the pack dir', () => {
    const dev = mkExe(path.join(tmp, 'bin-out'), 'fake-parse')
    const r = resolveBinary(exeDecl(), { packDir: tmp, envValue: null, settingsValue: undefined })
    expect(r).toMatchObject({ value: dev, source: 'pack-dev' })
  })

  it('uses bundled resourcesPath/bin when dev misses', () => {
    const bundled = mkExe(path.join(tmp, 'resources', 'bin'), 'fake-parse')
    const r = resolveBinary(exeDecl(), {
      packDir: tmp, envValue: null, settingsValue: undefined,
      resourcesPath: path.join(tmp, 'resources')
    })
    expect(r).toMatchObject({ value: bundled, source: 'bundled' })
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

  it('env dir wins; null when nothing exists (no PATH probe for dirs)', () => {
    const envDir = path.join(tmp, 'env-dir')
    fs.mkdirSync(envDir, { recursive: true })
    expect(
      resolveBinary(dirDecl(), { packDir: tmp, envValue: envDir, settingsValue: undefined })
    ).toMatchObject({ value: envDir, source: 'env' })
    expect(
      resolveBinary(dirDecl(), { packDir: path.join(tmp, 'nope'), envValue: null, settingsValue: undefined })
    ).toMatchObject({ value: null, source: null })
  })
})
