// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SetupWizard } from '../SetupWizard'

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
})
