// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { GeneralSettings } from '../GeneralSettings'
import { onboardingReplay } from '../../../lib/onboardingStore'
import { tourStore } from '../../../lib/tourStore'
import { defaultSettings } from '../../../../../shared/settings'
import type { SettingsPayload } from '../../../../../shared/settings'

const payload: SettingsPayload = {
  settings: defaultSettings(),
  resolvedTools: [],
  dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
  loadError: null
}

afterEach(() => {
  vi.restoreAllMocks()
  onboardingReplay.clear()
  tourStore.exitTour()
})

describe('GeneralSettings onboarding replay', () => {
  it('fires an explicit replay request when Re-run onboarding is clicked', () => {
    const spy = vi.spyOn(onboardingReplay, 'request')
    render(<GeneralSettings payload={payload} />)
    expect(onboardingReplay.get()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /re-run onboarding/i }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(onboardingReplay.get()).toBe(true)
  })

  it('Take the feature tour opens the tour', () => {
    render(<GeneralSettings payload={payload} />)
    fireEvent.click(screen.getByRole('button', { name: /take the feature tour/i }))
    expect(tourStore.get().open).toBe(true)
  })
})
