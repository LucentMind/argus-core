// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { HeaderChips } from '../HeaderChips'
import { prStatusStore } from '../../lib/prStatusStore'
import type { PrStatus } from '../../../../shared/prStatus'

// prStatusStore's only writers are hydrate(map) and forget(slug) — there is no set/reset.
const PR: PrStatus = {
  owner: 'acme',
  repo: 'core',
  number: 16909,
  url: 'https://github.com/acme/core/pull/16909',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  rollup: 'failing',
  checks: [],
  fetchedAt: '2026-07-31T14:01:00.000Z',
  error: null
}

beforeEach(() => {
  prStatusStore.forget('case-a')
})

describe('HeaderChips', () => {
  it('renders nothing when the case has no bound PR', () => {
    const { container } = render(<HeaderChips slug="case-a" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the PR number as a link when one is bound', () => {
    prStatusStore.hydrate({ 'case-a': PR })
    render(<HeaderChips slug="case-a" />)
    expect(screen.getByText('#16909')).toBeTruthy()
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://github.com/acme/core/pull/16909'
    )
  })

  it('does not render agent readiness or cost — those moved to the chat panel', () => {
    prStatusStore.hydrate({ 'case-a': PR })
    render(<HeaderChips slug="case-a" />)
    expect(screen.queryByText(/tok/)).toBeNull()
    expect(screen.queryByText(/ready/)).toBeNull()
  })
})
