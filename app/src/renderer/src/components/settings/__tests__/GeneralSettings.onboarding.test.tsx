// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { GeneralSettings } from '../GeneralSettings'
import { onboardingReplay } from '../../../lib/onboardingStore'
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
})
