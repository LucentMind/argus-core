// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
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
  it('commits hivemind.repo on blur', () => {
    render(<GeneralSettings payload={payload} />)
    const input = screen.getByLabelText('HiveMind repo')
    fireEvent.change(input, { target: { value: 'acme/hivemind' } })
    fireEvent.blur(input)
    expect(settingsStore.patch).toHaveBeenCalledWith({ hivemind: { repo: 'acme/hivemind' } })
  })
})
