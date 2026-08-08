// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { it, expect, afterEach } from 'vitest'
import { CaseCard } from '../CaseCard'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

const noop = {
  onOpen: () => {},
  onExport: () => {},
  onDelete: () => {},
  note: null
}

/** Two days before the card renders, so `updated 2d ago` is stable whenever the suite runs. */
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()

function baseCase(patch: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 1,
    slug: 'NAV-1',
    origin: 'user',
    reviewState: null,
    title: 'Bearing jumps',
    jiraKey: 'NAV-1',
    jiraSyncedAt: null,
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: null,
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: 'open',
    resolution: null,
    phase: 'open',
    activeMode: DEFAULT_MODE,
    tags: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: twoDaysAgo,
    actionItems: [],
    ...patch
  }
}

afterEach(cleanup)

it('shows a Draft badge for an unreviewed routine draft', () => {
  render(<CaseCard c={baseCase({ origin: 'routine', reviewState: 'draft' })} {...noop} />)
  expect(screen.getByText('Draft')).toBeInTheDocument()
  expect(screen.getByText('Routine')).toBeInTheDocument()
})

it('drops the Draft badge once accepted, keeping the Routine chip', () => {
  render(<CaseCard c={baseCase({ origin: 'routine', reviewState: null })} {...noop} />)
  expect(screen.queryByText('Draft')).not.toBeInTheDocument()
  expect(screen.getByText('Routine')).toBeInTheDocument()
})

it('shows no Draft badge on an ordinary case', () => {
  render(<CaseCard c={baseCase({ origin: 'user', reviewState: null })} {...noop} />)
  expect(screen.queryByText('Draft')).not.toBeInTheDocument()
})
