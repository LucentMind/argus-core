import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveTraceBinDir } from '../preflight'

let tmp: string | null = null

afterEach(() => {
  delete process.env.ARGUS_TRACE_DIR
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('resolveTraceBinDir', () => {
  it('finds the dev venv scripts dir next to the app root', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pf-'))
    const appRoot = path.join(tmp, 'app')
    const scripts = path.join(
      tmp, 'trace-tools', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'
    )
    fs.mkdirSync(appRoot, { recursive: true })
    fs.mkdirSync(scripts, { recursive: true })
    expect(resolveTraceBinDir(appRoot)).toBe(scripts)
  })

  it('prefers ARGUS_TRACE_DIR when set', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pf-'))
    process.env.ARGUS_TRACE_DIR = tmp
    expect(resolveTraceBinDir(path.join(tmp, 'nope'))).toBe(tmp)
  })

  it('returns null when nothing is found', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pf-'))
    expect(resolveTraceBinDir(path.join(tmp, 'app'))).toBeNull()
  })
})
