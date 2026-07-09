import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveArgusParse } from '../parsers'

const saved = process.env.ARGUS_PARSE_BIN
afterEach(() => {
  if (saved === undefined) delete process.env.ARGUS_PARSE_BIN
  else process.env.ARGUS_PARSE_BIN = saved
})

describe('resolveArgusParse', () => {
  it('honours ARGUS_PARSE_BIN when the file exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bin-'))
    const bin = path.join(tmp, 'sample-parse')
    fs.writeFileSync(bin, '#!/bin/sh\n')
    fs.chmodSync(bin, 0o755)
    process.env.ARGUS_PARSE_BIN = bin
    expect(resolveArgusParse('/nonexistent')).toBe(bin)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('falls back to the dev cargo target when present', () => {
    delete process.env.ARGUS_PARSE_BIN
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-root-'))
    const target = path.join(tmp, 'trace-rs', 'target', 'release')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'sample-parse'), '#!/bin/sh\n')
    expect(resolveArgusParse(path.join(tmp, 'app'))).toBe(path.join(target, 'sample-parse'))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('finds the .exe variant in the dev cargo target (windows builds)', () => {
    delete process.env.ARGUS_PARSE_BIN
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-root-'))
    const target = path.join(tmp, 'trace-rs', 'target', 'release')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'sample-parse.exe'), 'MZ')
    expect(resolveArgusParse(path.join(tmp, 'app'))).toBe(path.join(target, 'sample-parse.exe'))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('settings value wins over dev/bundled/PATH but loses to env', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-parse-'))
    try {
      const settingsBin = path.join(tmp2, 'sample-parse.exe')
      fs.writeFileSync(settingsBin, '')
      // env unset → settings wins
      expect(resolveArgusParse(path.join(tmp2, 'app'), settingsBin)).toBe(settingsBin)
      // env set → env wins
      const envBin = path.join(tmp2, 'env-parse.exe')
      fs.writeFileSync(envBin, '')
      process.env.ARGUS_PARSE_BIN = envBin
      expect(resolveArgusParse(path.join(tmp2, 'app'), settingsBin)).toBe(envBin)
    } finally {
      delete process.env.ARGUS_PARSE_BIN
      fs.rmSync(tmp2, { recursive: true, force: true })
    }
  })

  it('nonexistent settings path is skipped', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-parse-'))
    try {
      expect(resolveArgusParse(path.join(tmp2, 'app'), path.join(tmp2, 'missing.exe'))).toBeNull()
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true })
    }
  })
})
