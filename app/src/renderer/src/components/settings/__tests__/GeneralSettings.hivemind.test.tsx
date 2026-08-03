// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { GeneralSettings } from '../GeneralSettings'
import { settingsStore } from '../../../lib/settingsStore'
import { updateStore } from '../../../lib/updateStore'
import { defaultSettings } from '../../../../../shared/settings'
import type { SettingsPayload } from '../../../../../shared/settings'

const payload: SettingsPayload = {
  settings: defaultSettings(),
  resolvedTools: [],
  dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
  loadError: null
}

beforeEach(() => {
  vi.spyOn(settingsStore, 'patch').mockResolvedValue(undefined as never)
  updateStore.clearForTests()
  // UpdateSettings (Task 4) now renders inside GeneralSettings and starts the
  // update store unconditionally on mount.
  window.argus = {
    // GeneralSettings' default-repositories row (Task 8) mounts RepoPickerMenu
    // unconditionally, which calls recent() on mount.
    workspaces: {
      pick: vi.fn(async () => null),
      recent: vi.fn(async () => [])
    },
    update: {
      status: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      check: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      download: vi.fn(async () => ({ currentVersion: '1.0.0', status: { phase: 'idle' } })),
      restart: vi.fn(async () => {}),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('GeneralSettings HiveMind section', () => {
  it('no longer renders the HiveMind repo row — it moved to its own settings page', () => {
    render(<GeneralSettings payload={payload} />)
    expect(screen.queryByLabelText('HiveMind repo')).not.toBeInTheDocument()
    expect(screen.queryByText('HiveMind')).not.toBeInTheDocument()
  })
})
