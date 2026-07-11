// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ObservabilitySettings } from '../ObservabilitySettings'

const payload = {
  settings: {
    observability: {
      langfuse: { enabled: false, host: '', publicKey: '', captureContent: false },
      dashboard: { hiddenCards: [] }
    }
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { window: { argus: unknown } }).window.argus = {
    settings: { patch: vi.fn().mockResolvedValue(undefined) },
    secrets: { set: vi.fn().mockResolvedValue(undefined), has: vi.fn().mockResolvedValue(false) }
  }
})

describe('ObservabilitySettings', () => {
  it('enables Langfuse via a patch', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    const toggle = await screen.findByLabelText(/enable langfuse/i)
    fireEvent.click(toggle)
    expect(window.argus.settings.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        observability: expect.objectContaining({
          langfuse: expect.objectContaining({ enabled: true })
        })
      })
    )
  })

  it('shows a content-capture warning', async () => {
    render(<ObservabilitySettings payload={payload as never} />)
    expect(await screen.findByText(/confidential/i)).toBeInTheDocument()
  })
})
