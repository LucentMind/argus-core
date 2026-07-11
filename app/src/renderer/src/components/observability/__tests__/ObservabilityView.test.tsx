// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObservabilityView } from '../ObservabilityView'

const sample = {
  totalCostUsd: 1.23,
  inputTokens: 1000,
  outputTokens: 500,
  byModel: [],
  turns: { total: 4, error: 1 },
  tools: { total: 3, denied: 1, byDecision: {}, byRisk: {} },
  findings: { total: 2, accepted: 1, rejected: 0, pending: 1 },
  latencyMs: { turnP50: 900, turnP95: 1500 },
  resolvedCases: 1,
  costPerResolvedCaseUsd: 2.46
}

beforeEach(() => {
  window.argus = {
    cases: { list: vi.fn().mockResolvedValue([]) },
    metrics: { global: vi.fn().mockResolvedValue(sample), case: vi.fn() }
  } as never
})

describe('ObservabilityView', () => {
  it('renders the total cost card', async () => {
    render(<ObservabilityView onOpenCase={() => {}} />)
    expect(await screen.findByText(/\$1\.23/)).toBeInTheDocument()
    expect(await screen.findByText(/Total cost/i)).toBeInTheDocument()
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
})
