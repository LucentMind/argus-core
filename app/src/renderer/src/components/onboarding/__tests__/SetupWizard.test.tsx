// @vitest-environment jsdom
import { useEffect } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SetupWizard } from '../SetupWizard'

function GateFalseStep({ setGate }: { setGate: (ok: boolean) => void }): React.JSX.Element {
  useEffect(() => {
    setGate(false) // real steps gate from an effect, not during render
  }, [setGate])
  return <div data-testid="gated" />
}

function AsyncGateStep({ setGate }: { setGate: (ok: boolean) => void }): React.JSX.Element {
  useEffect(() => {
    setGate(false) // synchronous: disable
    void Promise.resolve().then(() => setGate(true)) // async: re-enable
  }, [setGate])
  return <div data-testid="async-step" />
}

describe('SetupWizard shell', () => {
  it('starts on welcome and advances on Continue', () => {
    render(<SetupWizard onComplete={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByTestId('wizard-step-claude')).toBeTruthy()
  })

  it('Back returns to the previous step', () => {
    render(<SetupWizard onComplete={vi.fn()} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByTestId('wizard-step-welcome')).toBeTruthy()
  })

  it('disables Continue while the active step gate is false', async () => {
    render(
      <SetupWizard
        onComplete={vi.fn()}
        onDismiss={vi.fn()}
        renderStep={(id, api) =>
          id === 'welcome' ? <GateFalseStep setGate={api.setGate} /> : <div />
        }
      />
    )
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled
      ).toBe(true)
    )
  })

  it('re-enables Continue when a step calls setGate asynchronously', async () => {
    render(
      <SetupWizard
        onComplete={vi.fn()}
        onDismiss={vi.fn()}
        renderStep={(id, api) =>
          id === 'welcome' ? <AsyncGateStep setGate={api.setGate} /> : <div />
        }
      />
    )
    // after the microtask resolves, Continue must be enabled again
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
  })
})
