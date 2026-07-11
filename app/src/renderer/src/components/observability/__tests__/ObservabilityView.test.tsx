// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObservabilityView } from '../ObservabilityView'
import { settingsStore } from '../../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../../shared/settings'

function settingsPayloadWith(hiddenCards: string[]): SettingsPayload {
  const settings = defaultSettings()
  settings.observability.dashboard.hiddenCards = hiddenCards
  return {
    settings,
    resolvedTools: {
      traceDir: { value: null, source: 'default' },
      parseBin: { value: null, source: 'default' }
    },
    dataRoot: { path: 'C:\\x', fromEnv: false },
    loadError: null
  }
}

const sample = {
  totalCostUsd: 1.23,
  inputTokens: 1000,
  outputTokens: 500,
  byModel: [],
  turns: { total: 4, error: 1 },
  tools: {
    total: 8,
    denied: 1,
    byDecision: { user: 1, grant: 1, denied: 1, auto: 5 },
    byRisk: {}
  },
  findings: { total: 2, accepted: 1, rejected: 0, pending: 1 },
  latencyMs: { turnP50: 900, turnP95: 1500 },
  resolvedCases: 1,
  costPerResolvedCaseUsd: 2.46
}

beforeEach(() => {
  settingsStore.reset()
  window.argus = {
    cases: { list: vi.fn().mockResolvedValue([]) },
    metrics: { global: vi.fn().mockResolvedValue(sample), case: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(settingsPayloadWith([])),
      patch: vi.fn(),
      onChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('ObservabilityView', () => {
  it('renders the total cost card', async () => {
    render(<ObservabilityView onOpenCase={() => {}} />)
    expect(await screen.findByText(/\$1\.23/)).toBeInTheDocument()
    expect(await screen.findByText(/Total cost/i)).toBeInTheDocument()
  })

  it('computes HITL approval from grant+user decisions over decision-requiring calls, excluding auto', async () => {
    render(<ObservabilityView onOpenCase={() => {}} />)
    // 2 approved (1 user + 1 grant) / 3 decisions (user + grant + denied) = 67%.
    // auto (5) must be excluded from the denominator, and 'grant' (the real
    // stored value for session-scoped approvals) must be counted -- a bug
    // computing `2/8` (via tools.total) would show 25%, and dropping `grant`
    // would show 33% (1/3).
    expect(await screen.findByText('67%')).toBeInTheDocument()
    expect(await screen.findByText(/3 decisions/i)).toBeInTheDocument()
  })

  it('shows per-case metrics when a case is selected', async () => {
    ;(window.argus as unknown as { cases: unknown }).cases = {
      list: vi.fn().mockResolvedValue([{ slug: 'c1', title: 'C1' }])
    }
    ;(window.argus.metrics.case as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockResolvedValue({ ...sample, totalCostUsd: 0.5 })
    render(<ObservabilityView onOpenCase={() => {}} />)
    const select = await screen.findByLabelText(/scope/i)
    fireEvent.change(select, { target: { value: 'c1' } })
    expect(await screen.findByText(/\$0\.50/)).toBeInTheDocument()
  })

  it('does not flash the previous case metrics when switching scope', async () => {
    ;(window.argus as unknown as { cases: unknown }).cases = {
      list: vi.fn().mockResolvedValue([
        { slug: 'c1', title: 'C1' },
        { slug: 'c2', title: 'C2' }
      ])
    }
    const bySlug: Record<string, typeof sample> = {
      c1: { ...sample, totalCostUsd: 0.5 },
      c2: { ...sample, totalCostUsd: 9.9 }
    }
    // c2's resolution is deliberately delayed relative to c1's, so we can
    // inspect the DOM in the window between selecting c2 and its IPC
    // resolving -- this is exactly the window where stale c1 data would flash.
    let resolveC2: (v: typeof sample) => void = () => {}
    const c2Promise = new Promise<typeof sample>((resolve) => {
      resolveC2 = resolve
    })
    ;(window.argus.metrics.case as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockImplementation((slug: string) =>
        slug === 'c2' ? c2Promise : Promise.resolve(bySlug[slug])
      )
    render(<ObservabilityView onOpenCase={() => {}} />)
    const select = await screen.findByLabelText(/scope/i)

    fireEvent.change(select, { target: { value: 'c1' } })
    expect(await screen.findByText(/\$0\.50/)).toBeInTheDocument()

    fireEvent.change(select, { target: { value: 'c2' } })
    // Before c2's promise resolves, the view must show loading/nothing --
    // NOT the stale c1 value.
    expect(await screen.findByText(/Loading metrics/i)).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.50/)).not.toBeInTheDocument()

    resolveC2(bySlug.c2)
    expect(await screen.findByText(/\$9\.90/)).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.50/)).not.toBeInTheDocument()
  })

  it('hides a card whose id is in the hiddenCards setting but keeps others visible', async () => {
    window.argus.settings.get = vi.fn().mockResolvedValue(settingsPayloadWith(['toolDenials']))
    render(<ObservabilityView onOpenCase={() => {}} />)
    expect(await screen.findByText(/Total cost/i)).toBeInTheDocument()
    expect(screen.queryByText(/Tool denials/i)).not.toBeInTheDocument()
  })

  it('still fetches metrics data even when a card is hidden', async () => {
    const globalSpy = vi.fn().mockResolvedValue(sample)
    window.argus.metrics.global = globalSpy
    window.argus.settings.get = vi.fn().mockResolvedValue(settingsPayloadWith(['toolDenials']))
    render(<ObservabilityView onOpenCase={() => {}} />)
    await screen.findByText(/Total cost/i)
    expect(globalSpy).toHaveBeenCalled()
  })
})
