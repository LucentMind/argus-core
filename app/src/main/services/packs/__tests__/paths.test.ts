import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { packsDir, resolvePacksSource, seedPacks, seededPacksDir, ensurePacksDir } from '../paths'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-packpaths-'))
  delete process.env.ARGUS_PACKS_DIR
  delete process.env.ARGUS_PACKS_SRC
})
afterEach(() => {
  delete process.env.ARGUS_PACKS_DIR
  delete process.env.ARGUS_PACKS_SRC
})

describe('packsDir', () => {
  it('defaults to <argusHome>/packs', () => {
    expect(packsDir('/home/x/Argus')).toBe(path.join('/home/x/Argus', 'packs'))
  })
  it('honors ARGUS_PACKS_DIR override', () => {
    process.env.ARGUS_PACKS_DIR = '/custom/packs'
    expect(packsDir('/home/x/Argus')).toBe('/custom/packs')
  })
})

describe('resolvePacksSource', () => {
  it('defaults to repo-root packs next to app', () => {
    expect(resolvePacksSource('/repo/app')).toBe(path.resolve('/repo/app', '..', 'packs'))
  })
})

describe('seedPacks', () => {
  it('copies packs from source into the data root', () => {
    const src = path.join(tmp, 'src-packs', 'sample')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'argus-pack.json'), '{}')
    const home = path.join(tmp, 'home')
    seedPacks(home, path.join(tmp, 'src-packs'))
    expect(fs.existsSync(path.join(home, 'packs', 'sample', 'argus-pack.json'))).toBe(true)
  })

  it('mkdirs an empty packs dir when the source is missing', () => {
    const home = path.join(tmp, 'home2')
    seedPacks(home, path.join(tmp, 'does-not-exist'))
    expect(fs.existsSync(path.join(home, 'packs'))).toBe(true)
  })

  it('no-ops safely when source equals dest (home == checkout)', () => {
    const home = path.join(tmp, 'home3')
    const dest = path.join(home, 'packs')
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'x')
    seedPacks(home, dest) // source IS the dest
    expect(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8')).toBe('x')
  })
})

describe('seededPacksDir', () => {
  it('honors ARGUS_PACKS_SRC over everything', () => {
    process.env.ARGUS_PACKS_SRC = '/custom/seed'
    expect(seededPacksDir('/repo/app', '/some/resources')).toBe('/custom/seed')
  })

  it('uses <resources>/packs.seed when that dir exists (packaged)', () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'))
    fs.mkdirSync(path.join(resources, 'packs.seed'), { recursive: true })
    expect(seededPacksDir('/repo/app', resources)).toBe(path.join(resources, 'packs.seed'))
  })

  it('falls back to repo-root packs/ when packs.seed is absent (dev)', () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'res-')) // no packs.seed inside
    expect(seededPacksDir('/repo/app', resources)).toBe(path.resolve('/repo/app', '..', 'packs'))
  })

  it('falls back to repo-root packs/ when no resourcesPath is given', () => {
    expect(seededPacksDir('/repo/app')).toBe(path.resolve('/repo/app', '..', 'packs'))
  })
})

describe('ensurePacksDir', () => {
  it('creates the writable packs dir and returns it', () => {
    const home = path.join(tmp, 'home-ensure')
    const dir = ensurePacksDir(home)
    expect(dir).toBe(path.join(home, 'packs'))
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('does not clobber existing content (idempotent)', () => {
    const home = path.join(tmp, 'home-ensure2')
    const dir = ensurePacksDir(home)
    fs.writeFileSync(path.join(dir, 'installed.txt'), 'x')
    ensurePacksDir(home) // second boot
    expect(fs.readFileSync(path.join(dir, 'installed.txt'), 'utf8')).toBe('x')
  })
})
