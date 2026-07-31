// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsView } from '../../settings/SettingsView'
import { settingsStore } from '../../../lib/settingsStore'
import { updateStore } from '../../../lib/updateStore'
import { defaultSettings } from '../../../../../shared/settings'

beforeEach(() => {
  updateStore.clearForTests()
  window.argus = {
    settings: {
      get: vi.fn(async () => ({
        settings: defaultSettings(),
        resolvedTools: [],
        dataRoot: { path: '', fromEnv: false },
        loadError: null
      })),
      onChanged: vi.fn(() => () => {})
    },
    proposals: {
      list: vi.fn(async () => ({ proposals: [] })),
      onChanged: vi.fn(() => () => {})
    },
    // OverrideBanner (Guard 3) subscribes on every Settings mount; the real preload exposes
    // this bridge unconditionally (main enforces the dev-tools gate), so the test stub must too.
    devPrompts: {
      overrides: vi.fn(async () => []),
      clearAll: vi.fn(async () => ({
        entries: [],
        modes: [],
        activeOverrideIds: [],
        loadError: null
      })),
      onChanged: vi.fn(() => () => {})
    },
    // UpdateSettings (Task 4) renders inside GeneralSettings, the default page, and
    // starts the update store unconditionally on mount.
    update: {
      status: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      check: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      download: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      restart: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {})
    }
  } as never
  settingsStore.reset()
})

describe('settings tab anchors', () => {
  it('memory/skills/references/hivemind tabs carry onboarding anchors', () => {
    const { container } = render(<SettingsView onClose={vi.fn()} />)
    for (const id of [
      'settings-memory',
      'settings-library',
      'settings-team',
      'settings-proposals'
    ]) {
      expect(container.querySelector(`[data-onboarding-anchor="${id}"]`)).toBeTruthy()
    }
  })
})
