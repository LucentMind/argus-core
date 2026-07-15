// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tourStore } from '../tourStore'
import { markTourDone } from '../onboardingStore'
import { settingsStore } from '../settingsStore'

describe('tourStore', () => {
  beforeEach(() => { tourStore.exitTour() })

  it('opens, advances, and exits', () => {
    expect(tourStore.get().open).toBe(false)
    tourStore.startTour()
    expect(tourStore.get()).toEqual({ open: true, index: 0 })
    tourStore.next()
    expect(tourStore.get().index).toBe(1)
    tourStore.back()
    expect(tourStore.get().index).toBe(0)
    tourStore.exitTour()
    expect(tourStore.get().open).toBe(false)
  })

  it('markTourDone patches tourDone + completedAt', async () => {
    const spy = vi.spyOn(settingsStore, 'patch').mockResolvedValue()
    await markTourDone()
    expect(spy).toHaveBeenCalledTimes(1)
    const arg = spy.mock.calls[0][0] as { onboarding: { tourDone: boolean; completedAt: string } }
    expect(arg.onboarding.tourDone).toBe(true)
    expect(typeof arg.onboarding.completedAt).toBe('string')
  })
})
