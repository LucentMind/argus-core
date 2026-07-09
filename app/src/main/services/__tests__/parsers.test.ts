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
})
