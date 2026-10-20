// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DistillationSection } from '../DistillationSection'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'

function payload(attributionDefault = true): SettingsPayload {
  const base = defaultSettings()
  return {
    settings: {
      ...base,
      distill: { ...base.distill, attribution: { default: attributionDefault } }
    },
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

describe('DistillationSection attribution default row', () => {
  it('renders the toggle bound to settings.distill.attribution.default and patches on click', async () => {
    render(<DistillationSection payload={payload(true)} />)
    const t = await screen.findByLabelText('Attribute skills and references by default')
    expect(t).toBeChecked()
    fireEvent.click(t)
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      distill: { attribution: { default: false } }
    })
  })

  it('offers a reset only once the default was turned off, and reset patches null', async () => {
    const { unmount } = render(<DistillationSection payload={payload(true)} />)
    await screen.findByLabelText('Attribute skills and references by default')
    expect(
      screen.queryByRole('button', { name: 'Reset Attribute skills and references by default' })
    ).toBeNull()
    unmount()
    render(<DistillationSection payload={payload(false)} />)
    const t = await screen.findByLabelText('Attribute skills and references by default')
    expect(t).not.toBeChecked()
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset Attribute skills and references by default' })
    )
    expect(window.argus.settings.patch).toHaveBeenCalledWith({
      distill: { attribution: { default: null } }
    })
  })
})
