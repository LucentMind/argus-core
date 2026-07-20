import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SettingsService } from '../../settings'
import { ensureTrackingStarted } from '../usage'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-usage-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('ensureTrackingStarted', () => {
  it('stamps once and never re-stamps', () => {
    const svc = new SettingsService(tmp)
    const t0 = new Date('2026-07-20T00:00:00.000Z')
    const first = ensureTrackingStarted(svc, () => t0)
    expect(first).toBe('2026-07-20T00:00:00.000Z')
    const second = ensureTrackingStarted(svc, () => new Date('2027-01-01T00:00:00.000Z'))
    expect(second).toBe('2026-07-20T00:00:00.000Z')
    expect(svc.get().memoryHygiene.trackingStartedAt).toBe('2026-07-20T00:00:00.000Z')
    svc.close()
  })
})
