import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPresets } from '../presets'
import { presetsPath } from '../paths'
import { DEFAULT_PRESETS } from '../../../shared/connectors'

let tmp: string, argusHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-presets-'))
  argusHome = path.join(tmp, 'home')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('loadPresets', () => {
  it('absent file → built-in defaults', () => {
    expect(loadPresets(argusHome)).toEqual(DEFAULT_PRESETS)
  })

  it('file deep-merges over defaults (override one value, add a preset)', () => {
    fs.mkdirSync(path.dirname(presetsPath(argusHome)), { recursive: true })
    fs.writeFileSync(
      presetsPath(argusHome),
      JSON.stringify({
        rovo: { config: { url: 'https://corp-proxy.example.com/mcp' } },
        internal: { displayName: 'Corp logs', kind: 'http', config: { url: 'https://x' } }
      }),
      'utf8'
    )
    const p = loadPresets(argusHome)
    expect(p.rovo.config).toMatchObject({ url: 'https://corp-proxy.example.com/mcp', oauth: true })
    expect(p.rovo.links.createApiToken).toContain('id.atlassian.com')
    expect(p.internal.displayName).toBe('Corp logs')
  })

  it('broken file → defaults (never throws)', () => {
    fs.mkdirSync(path.dirname(presetsPath(argusHome)), { recursive: true })
    fs.writeFileSync(presetsPath(argusHome), '{broken', 'utf8')
    expect(loadPresets(argusHome)).toEqual(DEFAULT_PRESETS)
  })
})
