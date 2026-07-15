// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { GeneralSettings } from '../GeneralSettings'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings } from '../../../../../shared/settings'
import type { SettingsPayload } from '../../../../../shared/settings'

const payload: SettingsPayload = {
  settings: defaultSettings(),
  resolvedTools: [],
  dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
  loadError: null
}

afterEach(() => vi.restoreAllMocks())

describe('GeneralSettings onboarding replay', () => {
  it('clears completedAt when Re-run onboarding is clicked', () => {
    const spy = vi.spyOn(settingsStore, 'patch').mockResolvedValue(undefined as never)
    render(<GeneralSettings payload={payload} />)
    fireEvent.click(screen.getByRole('button', { name: /re-run onboarding/i }))
    expect(spy).toHaveBeenCalledWith({ onboarding: { completedAt: null } })
  })
})
