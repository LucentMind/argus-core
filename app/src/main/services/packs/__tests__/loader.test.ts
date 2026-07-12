import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadPacks } from '../loader'

let root: string
function pack(id: string, manifest: object, files: Record<string, string> = {}): void {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'argus-pack.json'), JSON.stringify(manifest))
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-packs-'))
})

describe('loadPacks', () => {
  it('loads a valid pack and resolves its persona text', () => {
    pack(
      'sample',
      { id: 'sample', displayName: 'Nav', version: '1', argusApi: '^1', persona: 'persona.md' },
      { 'persona.md': 'NAV RULES' }
    )
    const { packs, errors } = loadPacks(root)
    expect(errors).toEqual([])
    expect(packs).toHaveLength(1)
    expect(packs[0].id).toBe('sample')
    expect(packs[0].personaText).toBe('NAV RULES')
  })

  it('ignores a subdir with no manifest (not an error)', () => {
    fs.mkdirSync(path.join(root, 'not-a-pack'), { recursive: true })
    expect(loadPacks(root)).toEqual({ packs: [], errors: [] })
  })

  it('records an error for an invalid manifest and skips it', () => {
    pack('bad', { displayName: 'no id', version: '1', argusApi: '^1' })
    const { packs, errors } = loadPacks(root)
    expect(packs).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].dir).toContain('bad')
  })

  it('records an error when the persona file is missing', () => {
    pack('sample', {
      id: 'sample',
      displayName: 'Nav',
      version: '1',
      argusApi: '^1',
      persona: 'persona.md'
    })
    const { packs, errors } = loadPacks(root)
    expect(packs).toHaveLength(0)
    expect(errors[0].message).toMatch(/persona/i)
  })

  it('returns packs sorted by id', () => {
    pack('zeta', { id: 'zeta', displayName: 'Z', version: '1', argusApi: '^1' })
    pack('alpha', { id: 'alpha', displayName: 'A', version: '1', argusApi: '^1' })
    expect(loadPacks(root).packs.map((p) => p.id)).toEqual(['alpha', 'zeta'])
  })

  it('returns empty for a non-existent packs dir', () => {
    expect(loadPacks(path.join(root, 'nope'))).toEqual({ packs: [], errors: [] })
  })

  it('records an error when manifest id does not match the directory name', () => {
    pack('wrong-dir', { id: 'sample', displayName: 'Nav', version: '1', argusApi: '^1' })
    const { packs, errors } = loadPacks(root)
    expect(packs).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/match its directory name/)
  })

  it('ignores an upgrade backup dir (<id>.bak) instead of reporting an id-mismatch error', () => {
    pack('sample', { id: 'sample', displayName: 'Nav', version: '1', argusApi: '^1' })
    // Simulate the backup installPack leaves behind after an upgrade: packsDir/sample.bak
    // containing the previous version's manifest, whose `id` is still 'sample'.
    const bakDir = path.join(root, 'sample.bak')
    fs.mkdirSync(bakDir, { recursive: true })
    fs.writeFileSync(
      path.join(bakDir, 'argus-pack.json'),
      JSON.stringify({ id: 'sample', displayName: 'Nav', version: '0', argusApi: '^1' })
    )
    const { packs, errors } = loadPacks(root)
    expect(errors).toEqual([])
    expect(packs).toHaveLength(1)
    expect(packs[0].id).toBe('sample')
  })

  it('ignores a leading-dot dir (e.g. a stray staging dir) even with a manifest inside', () => {
    const staging = path.join(root, '.staging')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(
      path.join(staging, 'argus-pack.json'),
      JSON.stringify({ id: 'staging', displayName: 'S', version: '1', argusApi: '^1' })
    )
    const { packs, errors } = loadPacks(root)
    expect(errors).toEqual([])
    expect(packs).toEqual([])
  })

  it('resolves skills/ and references/ asset dirs when present', () => {
    pack('sample', { id: 'sample', displayName: 'Nav', version: '1', argusApi: '^1' })
    fs.mkdirSync(path.join(root, 'sample', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(root, 'sample', 'references'), { recursive: true })
    const { packs } = loadPacks(root)
    expect(packs[0].skillsDir).toBe(path.join(root, 'sample', 'skills'))
    expect(packs[0].referencesDir).toBe(path.join(root, 'sample', 'references'))
  })

  it('asset dirs are null when absent', () => {
    pack('bare', { id: 'bare', displayName: 'Bare', version: '1', argusApi: '^1' })
    const { packs } = loadPacks(root)
    expect(packs[0].skillsDir).toBeNull()
    expect(packs[0].referencesDir).toBeNull()
  })
})

describe('argusApi load-time gate', () => {
  it('skips a pack whose argusApi is incompatible with the Core API', () => {
    pack('future', { id: 'future', displayName: 'F', version: '1', argusApi: '^2' })
    const { packs, errors } = loadPacks(root)
    expect(packs.find((p) => p.id === 'future')).toBeUndefined()
    expect(
      errors.some((e) => e.dir.includes('future') && /argusApi|incompatible/i.test(e.message))
    ).toBe(true)
  })

  it('loads a pack whose argusApi includes the Core API', () => {
    pack('ok', { id: 'ok', displayName: 'O', version: '1', argusApi: '^1' })
    const { packs, errors } = loadPacks(root)
    expect(packs.find((p) => p.id === 'ok')).toBeDefined()
    expect(errors).toEqual([])
  })
})

describe('ui/ + windows[] loading', () => {
  it('resolves uiDir when the pack ships ui/', () => {
    pack('nav', {
      id: 'nav',
      displayName: 'Nav',
      version: '1',
      argusApi: '^1',
      windows: [{ id: 'v', kind: 'webPanel', title: 'V', entry: 'v/index.html' }]
    })
    fs.mkdirSync(path.join(root, 'nav', 'ui', 'v'), { recursive: true })
    fs.writeFileSync(path.join(root, 'nav', 'ui', 'v', 'index.html'), '<!doctype html>')
    const { packs, errors } = loadPacks(root)
    expect(errors).toEqual([])
    expect(packs[0].uiDir).toBe(path.join(root, 'nav', 'ui'))
  })

  it('uiDir is null when the pack has no windows and no ui/', () => {
    pack('nav', { id: 'nav', displayName: 'Nav', version: '1', argusApi: '^1' })
    expect(loadPacks(root).packs[0].uiDir).toBeNull()
  })

  it('skips a pack that declares windows but ships no ui/ dir', () => {
    pack('nav', {
      id: 'nav',
      displayName: 'Nav',
      version: '1',
      argusApi: '^1',
      windows: [{ id: 'v', kind: 'webPanel', title: 'V', entry: 'v/index.html' }]
    })
    const { packs, errors } = loadPacks(root)
    expect(packs).toHaveLength(0)
    expect(errors[0].message).toMatch(/ui\//)
  })

  it("skips a pack whose window entry doesn't exist under ui/", () => {
    pack('nav', {
      id: 'nav',
      displayName: 'Nav',
      version: '1',
      argusApi: '^1',
      windows: [{ id: 'v', kind: 'webPanel', title: 'V', entry: 'v/missing.html' }]
    })
    fs.mkdirSync(path.join(root, 'nav', 'ui'), { recursive: true })
    const { packs, errors } = loadPacks(root)
    expect(packs).toHaveLength(0)
    expect(errors[0].message).toMatch(/missing\.html|entry/)
  })

  it('skips a pack whose window entry escapes ui/ (path traversal)', () => {
    pack('nav', {
      id: 'nav',
      displayName: 'Nav',
      version: '1',
      argusApi: '^1',
      windows: [{ id: 'v', kind: 'webPanel', title: 'V', entry: '../persona.md' }]
    })
    fs.mkdirSync(path.join(root, 'nav', 'ui'), { recursive: true })
    const { packs, errors } = loadPacks(root)
    expect(packs).toHaveLength(0)
    expect(errors[0].message).toMatch(/entry|ui\//)
  })
})
