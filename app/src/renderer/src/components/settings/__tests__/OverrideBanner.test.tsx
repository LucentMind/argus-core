// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { OverrideBanner } from '../OverrideBanner'

vi.mock('../../../lib/confirmStore', async (orig) => ({
  ...(await orig<typeof import('../../../lib/confirmStore')>()),
  confirm: vi.fn(async () => true)
}))

function stubBridge(ids: string[]): { clearAll: ReturnType<typeof vi.fn> } {
  const clearAll = vi.fn(async () => ({
    entries: [],
    modes: [],
    activeOverrideIds: [],
    loadError: null
  }))
  ;(window as unknown as { argus: unknown }).argus = {
    devPrompts: {
      overrides: vi.fn(async () => ids),
      clearAll,
      onChanged: vi.fn(() => () => {})
    }
  }
  return { clearAll }
}

beforeEach(() => stubBridge([]))

describe('OverrideBanner', () => {
  it('renders nothing when no override is active', async () => {
    const { container } = render(<OverrideBanner devTools={true} />)
    // Gate on the mocked IPC having resolved before asserting emptiness, or this passes
    // trivially against the pre-fetch render.
    await waitFor(() =>
      expect(
        (window as unknown as { argus: { devPrompts: { overrides: ReturnType<typeof vi.fn> } } })
          .argus.devPrompts.overrides
      ).toHaveBeenCalled()
    )
    expect(container.textContent).toBe('')
  })

  it('names the active overrides when there are some', async () => {
    stubBridge(['persona.neutral', 'tool.grep_lines.description'])
    render(<OverrideBanner devTools={true} />)
    expect(await screen.findByText(/2 prompt overrides are active/i)).toBeInTheDocument()
    expect(screen.getByText(/persona\.neutral/)).toBeInTheDocument()
  })

  it('clears them all on confirmation', async () => {
    const { clearAll } = stubBridge(['persona.neutral'])
    render(<OverrideBanner devTools={true} />)
    fireEvent.click(await screen.findByRole('button', { name: /clear all/i }))
    await waitFor(() => expect(clearAll).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/overrides are active/i)).not.toBeInTheDocument())
  })

  it('never calls the gated channel when devTools is off', async () => {
    // The channel would reject, and an unhandled rejection on every Settings mount in a normal
    // build is noise that trains people to ignore the console.
    stubBridge(['persona.neutral'])
    render(<OverrideBanner devTools={false} />)
    const api = (
      window as unknown as { argus: { devPrompts: { overrides: ReturnType<typeof vi.fn> } } }
    ).argus.devPrompts
    expect(api.overrides).not.toHaveBeenCalled()
  })
})
