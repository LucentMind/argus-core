// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { it, expect, afterEach } from 'vitest'
import { CaseCard } from '../CaseCard'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'
import type { PrStatus } from '../../../../shared/prStatus'

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

const noop = {
  onOpen: () => {},
  onExport: () => {},
  onDelete: () => {},
  note: null
}

/** Two days before the card renders, so `updated 2d ago` is stable whenever the suite runs. */
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()

function mkCase(patch: Partial<CaseRecord>): CaseRecord {
  return {
    id: 1,
    slug: 'NAV-1',
    origin: 'user',
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

it('puts the ticket id in ink and the title in signal', () => {
  render(<CaseCard c={mkCase({ slug: 'KAN-22', title: 'Aufgabe 22' })} {...noop} />)
  expect(screen.getByText('KAN-22').className).toContain('text-ink')
  expect(screen.getByTestId('case-title').className).toContain('text-signal')
})

it('shows the upstream Jira status and the last-activity age', () => {
  render(
    <CaseCard
      c={mkCase({ jiraKey: 'KAN-22', jiraStatus: 'In Progress', updatedAt: twoDaysAgo })}
      {...noop}
    />
  )
  expect(screen.getByTestId('case-context')).toHaveTextContent('Jira: In Progress · updated 2d ago')
})

it('omits the Jira part for a case with no ticket', () => {
  render(<CaseCard c={mkCase({ jiraKey: null, updatedAt: twoDaysAgo })} {...noop} />)
  expect(screen.getByTestId('case-context')).toHaveTextContent('updated 2d ago')
  expect(screen.getByTestId('case-context')).not.toHaveTextContent('Jira')
})

it('shows totals muted, and promotes them when something new arrived', () => {
  render(
    <CaseCard
      c={mkCase({ jiraKey: 'K-1', jiraCommentCount: 12, jiraAttachmentIds: ['a', 'b'] })}
      {...noop}
    />
  )
  expect(screen.getByTestId('metric-comments')).toHaveTextContent('12')
  expect(screen.getByTestId('metric-comments').className).toContain('text-mute')

  cleanup()
  render(
    <CaseCard
      c={mkCase({
        jiraKey: 'K-1',
        jiraCommentCount: 12,
        actionItems: [{ kind: 'comments', severity: 'action', label: '2 new comments', count: 2 }]
      })}
      {...noop}
    />
  )
  const hot = screen.getByTestId('metric-comments')
  expect(hot.className).toContain('text-defect')
  expect(hot.getAttribute('title')).toBe('12 comments · 2 new')
})

it('shows no metrics at all for a case with no ticket', () => {
  render(<CaseCard c={mkCase({ jiraKey: null })} {...noop} />)
  expect(screen.queryByTestId('metric-comments')).not.toBeInTheDocument()
})

it('renders singular "comment" in the tooltip when the comment count is exactly 1', () => {
  render(
    <CaseCard c={mkCase({ jiraKey: 'NAV-1', jiraCommentCount: 1 })} {...noop} />
  )
  const metric = screen.getByTestId('metric-comments')
  expect(metric.getAttribute('title')).toBe('1 comment')
})

it('renders the full PR face, not just the CI rollup', () => {
  render(
    <CaseCard
      c={mkCase({})}
      prStatus={{ ...BASE_PR, state: 'MERGED', rollup: 'failing' }}
      {...noop}
    />
  )
  expect(screen.getByRole('img', { name: /merged/i })).toBeInTheDocument()
})

it('renders no PR glyph when the case has no bound PR', () => {
  render(<CaseCard c={mkCase({})} {...noop} />)
  expect(screen.queryByRole('img', { name: /^PR #/ })).not.toBeInTheDocument()
})
