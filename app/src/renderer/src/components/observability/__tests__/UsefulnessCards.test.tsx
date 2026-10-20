// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UsefulnessCards, USEFULNESS_CAVEAT } from '../UsefulnessCards'
import { DASHBOARD_CARDS } from '../../settings/ObservabilitySettings'

const asset = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'skill',
  name: 'diag',
  tier: 'user',
  applied: 4,
  helped: 3,
  neutral: 0,
  misled: 1,
  silent: 0,
  helpedRate: 0.75,
  byDomain: {
    NAV: { applied: 3, helped: 3, neutral: 0, misled: 0, outcomes: {} },
    INFRA: { applied: 1, helped: 0, neutral: 0, misled: 1, outcomes: {} }
  },
  emergentDomains: ['NAV'],
  outcomes: { solved: 4 },
  lastAppliedAt: null,
  ...over
})
const payload = (usefulness: unknown[]): Record<string, unknown> => ({
  hygiene: {},
  skills: [],
  memory: [],
  references: [],
  archived: [],
  distillation: { jobCount: 0, failedCount: 0, dryRunCount: 0 },
  usefulness
})

describe('UsefulnessCards', () => {
  beforeEach(() => {
    window.argus = {
      usage: {
        stats: vi.fn(async () =>
          payload([
            asset({}),
            asset({
              name: 'thin',
              applied: 1,
              helped: 1,
              helpedRate: null,
              byDomain: { NAV: { applied: 1, helped: 1, neutral: 0, misled: 0, outcomes: {} } },
              emergentDomains: []
            })
          ])
        )
      }
    } as never
  })
  it('renders the table, caveat and emergent-domain chips; too-few-cases rows show —', async () => {
    render(<UsefulnessCards hiddenCards={[]} />)
    expect(await screen.findByText('Knowledge usefulness')).toBeInTheDocument()
    expect(screen.getByText(USEFULNESS_CAVEAT)).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByTitle('too few cases')).toHaveTextContent('—')
    expect(screen.getByText('NAV', { selector: 'span' })).toBeInTheDocument()
  })
  it('the domain filter narrows counts to that domain', async () => {
    render(<UsefulnessCards hiddenCards={[]} />)
    await screen.findByText('Knowledge usefulness')
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'INFRA' } })
    const row = screen.getByText('diag').closest('tr')!
    expect(row).toHaveTextContent('1') // applied in INFRA
    expect(screen.queryByText('thin')).toBeNull() // no INFRA rows
  })
  it('a domain view shows that domain counts and rate, and keeps the asset emergent chips', async () => {
    render(<UsefulnessCards hiddenCards={[]} />)
    await screen.findByText('Knowledge usefulness')
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'NAV' } })
    const row = screen.getByText('diag').closest('tr')!
    const cells = Array.from(row.querySelectorAll('td')).map((c) => c.textContent)
    // asset, kind, applied, helped, misled, rate, domains
    expect(cells.slice(0, 6)).toEqual(['diag', 'skill', '3', '3', '0', '100%'])
    expect(cells[6]).toBe('NAV')
    // 'thin' has 1 applied in NAV: under MIN_APPLIED -> —
    const thin = screen.getByText('thin').closest('tr')!
    expect(thin.querySelector('[title="too few cases"]')).toHaveTextContent('—')
  })
  it('a domain view under MIN_APPLIED shows — for the rate', async () => {
    render(<UsefulnessCards hiddenCards={[]} />)
    await screen.findByText('Knowledge usefulness')
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'INFRA' } })
    const row = screen.getByText('diag').closest('tr')!
    expect(row.querySelector('[title="too few cases"]')).toHaveTextContent('—')
  })
  it('renders nothing when there is no usefulness data or the card is hidden', async () => {
    ;(window.argus.usage.stats as ReturnType<typeof vi.fn>).mockResolvedValueOnce(payload([]))
    const { container, rerender } = render(<UsefulnessCards hiddenCards={[]} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
    rerender(<UsefulnessCards hiddenCards={['usefulness.assets']} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('a hidden card renders no [data-card-id] even with data', async () => {
    const { container } = render(<UsefulnessCards hiddenCards={['usefulness.assets']} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('[data-card-id]')).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })
  it('tolerates a stats payload without usefulness', async () => {
    ;(window.argus.usage.stats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      distillation: { jobCount: 0, failedCount: 0, dryRunCount: 0 }
    })
    const { container } = render(<UsefulnessCards hiddenCards={[]} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
  })
  it('its root carries data-card-id="usefulness.assets" and the id is registered in DASHBOARD_CARDS', async () => {
    const { container } = render(<UsefulnessCards hiddenCards={[]} />)
    await screen.findByText('Knowledge usefulness')
    expect(container.querySelector('[data-card-id="usefulness.assets"]')).not.toBeNull()
    expect(DASHBOARD_CARDS.map((c) => c.id)).toContain('usefulness.assets')
  })
})
