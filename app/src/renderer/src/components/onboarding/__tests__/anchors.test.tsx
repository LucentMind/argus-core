// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsView } from '../../settings/SettingsView'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings } from '../../../../../shared/settings'

beforeEach(() => {
  window.argus = {
    settings: {
      get: vi.fn(async () => ({
        settings: defaultSettings(),
        resolvedTools: [],
        dataRoot: { path: '', fromEnv: false },
        loadError: null
      })),
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
      'settings-skills',
      'settings-references',
      'settings-hivemind'
    ]) {
      expect(container.querySelector(`[data-onboarding-anchor="${id}"]`)).toBeTruthy()
    }
  })
})
