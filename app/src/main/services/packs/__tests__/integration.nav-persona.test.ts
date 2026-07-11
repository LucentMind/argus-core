import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { packsDir, resolvePacksSource, seedPacks } from '../paths'
import { PackRegistry } from '../registry'
import { composePersona } from '../../agent/persona'

// End-to-end proof that the real repo-root sample pack seeds into a fresh
// argusHome and loads through the registry — the same seam wired in
// src/main/index.ts (seedPacks + PackRegistry.load + personaFragments()).

let tmp: string
let argusHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-nav-persona-'))
  argusHome = path.join(tmp, 'ArgusHome')
  delete process.env.ARGUS_PACKS_DIR
  delete process.env.ARGUS_PACKS_SRC
})

afterEach(() => {
  delete process.env.ARGUS_PACKS_DIR
  delete process.env.ARGUS_PACKS_SRC
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('sample pack end-to-end wiring', () => {
  it('seeds the real repo packs/sample, loads it, and composes its persona fragment', () => {
    // Resolve the repo's real packs/ source the same way index.ts does:
    // resolvePacksSource(appRoot) === <appRoot>/../packs. When tests run
    // from app/, process.cwd() *is* that app root.
    const source = resolvePacksSource(process.cwd())
    expect(fs.existsSync(path.join(source, 'sample', 'argus-pack.json'))).toBe(true)

    seedPacks(argusHome, source)

    const reg = PackRegistry.load(packsDir(argusHome))
    expect(reg.errors()).toEqual([])

    const fragments = reg.personaFragments()
    expect(fragments.some((f) => f.includes('TRACE FILES'))).toBe(true)

    const composed = composePersona(fragments)
    expect(composed).toContain('CITATIONS')
    expect(composed).toContain('TRACE FILES')
  })
})
