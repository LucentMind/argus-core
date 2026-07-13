import { describe, it, expect } from 'vitest'
import { ExternalAppsStore } from '../externalAppsStore'
import type { ExternalAppInfo } from '../../../../shared/panels'

const app = (over: Partial<ExternalAppInfo> = {}): ExternalAppInfo => ({
  caseSlug: 'CASE-A',
  packId: 'ext',
  windowId: 'sim',
  title: 'Sim',
  status: 'running',
  ...over
})

describe('ExternalAppsStore', () => {
  it('setApps replaces the list and notifies subscribers', () => {
    const s = new ExternalAppsStore()
    let n = 0
    s.subscribe(() => n++)
    s.setApps([app()])
    expect(s.get().apps).toHaveLength(1)
    expect(n).toBe(1)
  })

  it('setCase to a new slug clears apps', () => {
    const s = new ExternalAppsStore()
    s.setApps([app()])
    s.setCase('CASE-B')
    expect(s.get().apps).toEqual([])
  })
})
