// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SeedStep } from '../steps'
import * as store from '../../../lib/onboardingStore'

afterEach(() => vi.restoreAllMocks())

describe('SeedStep', () => {
  it('seeds the sample case and reports the slug', async () => {
    window.argus = {
      onboarding: {
        seedSample: vi.fn(async () => ({ slug: 'sample-onboarding', evidenceIds: [1] }))
      }
    } as never
    vi.spyOn(store, 'markPhase1Done').mockResolvedValue()
    const onSeeded = vi.fn()
    render(<SeedStep setGate={vi.fn()} onSeeded={onSeeded} />)
    await waitFor(() => expect(onSeeded).toHaveBeenCalledWith('sample-onboarding'))
    expect(store.markPhase1Done).toHaveBeenCalledWith('sample-onboarding')
  })

  it('gates Finish (setGate(true)) only after seeding succeeds', async () => {
    window.argus = {
      onboarding: {
        seedSample: vi.fn(async () => ({ slug: 'sample-onboarding', evidenceIds: [1] }))
      }
    } as never
    vi.spyOn(store, 'markPhase1Done').mockResolvedValue()
    const setGate = vi.fn()
    render(<SeedStep setGate={setGate} onSeeded={vi.fn()} />)
    // Immediately disabled while seeding is in flight.
    await waitFor(() => expect(setGate).toHaveBeenCalledWith(false))
    await waitFor(() => expect(setGate).toHaveBeenCalledWith(true))
  })

  it('never enables Finish when seeding fails', async () => {
    window.argus = {
      onboarding: {
        seedSample: vi.fn(async () => {
          throw new Error('boom')
        })
      }
    } as never
    const setGate = vi.fn()
    render(<SeedStep setGate={setGate} onSeeded={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/couldn.t seed the sample case/i)).toBeTruthy())
    expect(setGate).not.toHaveBeenCalledWith(true)
  })
})
