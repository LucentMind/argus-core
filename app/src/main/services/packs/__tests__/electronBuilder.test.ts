import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// __dirname = app/src/main/services/packs/__tests__ → up 5 = app/
const YML = path.join(__dirname, '../../../../..', 'electron-builder.yml')

describe('electron-builder config (pack-free Core)', () => {
  const text = fs.readFileSync(YML, 'utf8')

  it('ships the internal packs as packs.seed', () => {
    expect(text).toContain('to: packs.seed')
  })

  it('bakes no domain binary into resources/bin', () => {
    expect(text).not.toContain('argus-parse')
    expect(text).not.toMatch(/^\s*to:\s*bin\s*$/m)
  })
})
