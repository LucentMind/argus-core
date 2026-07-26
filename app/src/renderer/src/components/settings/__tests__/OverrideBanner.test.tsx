// @vitest-environment jsdom
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { OverrideBanner } from '../OverrideBanner'

vi.mock('../../../lib/confirmStore', async (orig) => ({
  ...(await orig<typeof import('../../../lib/confirmStore')>()),
  confirm: vi.fn(async () => true)
}))

function stubBridge(ids: string[]): {
  clearAll: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
} {
  const clearAll = vi.fn(async () => ({
    entries: [],
    modes: [],
    activeOverrideIds: [],
    loadError: null
  }))
  const onChanged = vi.fn(() => () => {})
  ;(window as unknown as { argus: unknown }).argus = {
    devPrompts: {
      overrides: vi.fn(async () => ids),
      clearAll,
      onChanged
    }
  }
  return { clearAll, onChanged }
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

  it('surfaces a failed clear-all without losing the override list', async () => {
    stubBridge(['persona.neutral'])
    ;(
      window as unknown as { argus: { devPrompts: { clearAll: ReturnType<typeof vi.fn> } } }
    ).argus.devPrompts.clearAll = vi.fn(async () => {
      throw new Error('EBUSY: file is locked')
    })
    render(<OverrideBanner devTools={true} />)
    fireEvent.click(await screen.findByRole('button', { name: /clear all/i }))

    expect(await screen.findByText(/EBUSY: file is locked/)).toBeInTheDocument()
    expect(screen.getByText(/persona\.neutral/)).toBeInTheDocument()
  })

  it('lights up when the change broadcast fires, without a Settings remount', async () => {
    // The comment in OverrideBanner.tsx claims "a save on the Prompts page must light the
    // banner without a Settings remount" — this is the only test that exercises that path.
    // Every other onChanged stub in this suite is a no-op that's never invoked, so the
    // preload-listener -> setIds -> re-render leg had zero coverage before this test.
    const { onChanged } = stubBridge([])
    render(<OverrideBanner devTools={true} />)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())

    const onBroadcast = onChanged.mock.calls[0][0] as (ids: string[]) => void
    act(() => onBroadcast(['persona.neutral', 'persona.diagram']))

    expect(await screen.findByText(/2 prompt overrides are active/i)).toBeInTheDocument()
    expect(screen.getByText(/persona\.neutral/)).toBeInTheDocument()
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
