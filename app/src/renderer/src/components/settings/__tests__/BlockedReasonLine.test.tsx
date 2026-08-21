// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BlockedReasonLine } from '../BlockedReasonLine'
import type { Candidate } from '../../../../../shared/currency'

const cand = (reason: Candidate['reason']): Candidate => ({
  domain: 'hive-reference',
  key: 'reference/a.md',
  label: 'a.md',
  from: 'x',
  to: 'y',
  verdict: 'blocked',
  reason
})

describe('BlockedReasonLine', () => {
  it('prefixes the reason with "Held back"', () => {
    render(<BlockedReasonLine candidate={cand({ kind: 'local-edits' })} />)
    expect(screen.getByText(/held back — you have edited this locally\./i)).toBeInTheDocument()
  })

  it('renders the tier-change values, not a generic sentence', () => {
    render(
      <BlockedReasonLine candidate={cand({ kind: 'tier-change', from: 'mine', to: 'hivemind' })} />
    )
    expect(screen.getByText(/from mine to hivemind/i)).toBeInTheDocument()
  })

  it('renders nothing for a candidate with no reason', () => {
    const { container } = render(<BlockedReasonLine candidate={cand(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for an unsupported block, which is not actionable', () => {
    const { container } = render(<BlockedReasonLine candidate={cand({ kind: 'unsupported' })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
