// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { GeneralSettings } from '../GeneralSettings'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings } from '../../../../../shared/settings'
import type { SettingsPayload } from '../../../../../shared/settings'

const payload: SettingsPayload = {
  settings: defaultSettings(),
  resolvedTools: {
    traceDir: { value: null, source: 'default' },
    parseBin: { value: null, source: 'default' }
  },
  dataRoot: { path: 'C:/tmp/argus', fromEnv: false },
  loadError: null
}

beforeEach(() => {
  vi.spyOn(settingsStore, 'patch').mockResolvedValue(undefined as never)
})

describe('GeneralSettings HiveMind section', () => {
  it('no longer renders the HiveMind repo row — it moved to its own settings page', () => {
    render(<GeneralSettings payload={payload} />)
    expect(screen.queryByLabelText('HiveMind repo')).not.toBeInTheDocument()
    expect(screen.queryByText('HiveMind')).not.toBeInTheDocument()
  })
})
