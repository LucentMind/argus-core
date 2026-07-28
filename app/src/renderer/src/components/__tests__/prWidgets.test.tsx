// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CaseCard } from '../CaseCard'
import type { CaseRecord } from '../../../../shared/types'

const kase = (): CaseRecord =>
  ({
    slug: 'c1',
    title: 'Case 1',
    status: 'open',
    actionItems: [],
    jiraKey: null,
    jiraSyncedAt: null
  }) as unknown as CaseRecord

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
        prRollup="failing"
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
