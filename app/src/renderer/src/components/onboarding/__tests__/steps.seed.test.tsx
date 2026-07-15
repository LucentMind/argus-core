// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
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
    render(<SeedStep onSeeded={onSeeded} />)
    await waitFor(() => expect(onSeeded).toHaveBeenCalledWith('sample-onboarding'))
    expect(store.markPhase1Done).toHaveBeenCalledWith('sample-onboarding')
  })
})
