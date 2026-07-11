import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../src/cli'

const SAMPLE = path.join(__dirname, 'fixtures', 'sample-pack')
const BIN = path.join(__dirname, 'fixtures', 'bin')
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'packtools-cli-'))

describe('cli run', () => {
  it('builds a bundle from valid flags (exit 0)', async () => {
    const out = tmp()
    const code = await run(['build', '--pack', SAMPLE, '--bin', BIN, '--platform', 'mac-arm64', '--out', out])
    expect(code).toBe(0)
    expect(fs.existsSync(path.join(out, 'sample-0.1.0-mac-arm64.zip'))).toBe(true)
  })

  it('errors on a missing required flag (non-zero)', async () => {
    const code = await run(['build', '--pack', SAMPLE, '--platform', 'mac-arm64', '--out', tmp()])
    expect(code).not.toBe(0)
  })

  it('errors on an unknown subcommand (non-zero)', async () => {
    const code = await run(['frobnicate'])
    expect(code).not.toBe(0)
  })
})
