// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DistillationSection } from '../DistillationSection'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

beforeEach(() => {
  window.argus = {
    settings: { patch: vi.fn(async () => payload()) },
    usage: { stats: vi.fn() }
  } as never
})

describe('DistillationSection spend row', () => {
  it('renders no spend row; spend lives on the Observability dashboard', async () => {
    render(<DistillationSection payload={payload()} />)
    await screen.findByText('Distillation provider')
    expect(screen.queryByText(/completed run/)).not.toBeInTheDocument()
    expect(window.argus.usage.stats).not.toHaveBeenCalled()
  })
})
