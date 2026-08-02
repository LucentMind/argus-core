// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CaseCard } from '../CaseCard'
import type { CaseRecord } from '../../../../shared/types'
import type { PrStatus } from '../../../../shared/prStatus'

const kase = (): CaseRecord =>
  ({
    slug: 'c1',
    title: 'Case 1',
    status: 'open',
    phase: 'open',
    actionItems: [],
    jiraKey: null,
    jiraSyncedAt: null
  }) as unknown as CaseRecord

/** A minimally "clean" open PR, so patching only `rollup` isolates the CI-verdict face from
 *  the merge/conflict/draft faces that `prFaceOf` would otherwise take precedence over. */
const BASE_PR: PrStatus = {
  owner: 'o',
  repo: 'r',
  number: 7,
  url: 'https://example.test/pr/7',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  rollup: 'passing',
  checks: [],
  fetchedAt: '2026-08-01T10:00:00.000Z',
  error: null
}

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = {
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: () => () => {}
    }
  }
})

describe('CaseCard PR rollup', () => {
  it('shows the dot when the case has a cached rollup', () => {
    render(
      <CaseCard
        c={kase()}
        prStatus={{ ...BASE_PR, rollup: 'failing' }}
        onOpen={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        note={null}
      />
    )
    expect(screen.getByRole('img', { name: /checks failing/i })).toBeInTheDocument()
  })

  it('shows no dot for a case with no bound PR', () => {
    render(
      <CaseCard c={kase()} onOpen={() => {}} onExport={() => {}} onDelete={() => {}} note={null} />
    )
    expect(screen.queryByRole('img', { name: /checks/i })).not.toBeInTheDocument()
  })
})
