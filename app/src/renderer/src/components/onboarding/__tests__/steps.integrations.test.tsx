// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IntegrationsStep } from '../steps'
import * as store from '../../../lib/onboardingStore'

// vi.spyOn on an already-spied export reuses the same mock and its accrued call
// history (no clearMocks/restoreMocks configured globally), so the second test's
// `not.toHaveBeenCalled()` would otherwise see calls left over from the first
// test. Restore spies between tests to keep them isolated.
afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  window.argus = {
    connectors: { get: vi.fn(async () => ({ oauth: { rovo: 'authorized' } })) },
    settings: { get: vi.fn(async () => ({ settings: { hivemind: { repo: 'org/hive' } } })) }
  } as never
})

describe('IntegrationsStep', () => {
  it('marks Atlassian (jira+confluence) and hive when configured', async () => {
    const spy = vi.spyOn(store, 'markIntegration').mockResolvedValue()
    render(<IntegrationsStep />)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('jira', true))
    expect(spy).toHaveBeenCalledWith('confluence', true)
    expect(spy).toHaveBeenCalledWith('hive', true)
    expect(screen.getByText(/Atlassian/)).toBeTruthy()
  })

  it('marks nothing when no oauth authorized and no repo set', async () => {
    window.argus = {
      connectors: { get: vi.fn(async () => ({ oauth: { rovo: 'not-authorized' } })) },
      settings: { get: vi.fn(async () => ({ settings: { hivemind: { repo: '' } } })) }
    } as never
    const spy = vi.spyOn(store, 'markIntegration').mockResolvedValue()
    render(<IntegrationsStep />)
    await waitFor(() => expect(window.argus.connectors.get).toHaveBeenCalled())
    expect(spy).not.toHaveBeenCalled()
  })
})
