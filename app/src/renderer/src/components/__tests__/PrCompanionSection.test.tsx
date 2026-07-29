// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PrCompanionSection } from '../PrCompanionSection'
import { prStatusStore } from '../../lib/prStatusStore'
import type { PrStatus } from '../../../../shared/prStatus'

const status = (over: Partial<PrStatus> = {}): PrStatus => ({
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  rollup: 'failing',
  checks: [
    {
      name: 'build',
      bucket: 'fail',
      url: 'https://github.com/acme/widget/actions/runs/1/job/9',
      jobId: 9
    },
    { name: 'lint', bucket: 'pass', url: null, jobId: null },
    { name: 'ci/circleci', bucket: 'fail', url: 'https://circleci.com/x', jobId: null }
  ],
  fetchedAt: '2026-07-27T12:00:00.000Z',
  error: null,
  ...over
})

beforeEach(() => {
  prStatusStore.hydrate({ c1: status() })
  ;(window as unknown as { argus: unknown }).argus = {
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: () => () => {}
    }
  }
})

describe('PrCompanionSection', () => {
  it('renders nothing outside review mode', () => {
    const { container } = render(
      <PrCompanionSection slug="c1" mode="triage" onAnalyze={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('names the PR nowhere (the Repos chip owns the identity) but shows decision and checks', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.queryByText('acme/widget#42')).not.toBeInTheDocument()
    expect(screen.getByText(/review required/i)).toBeInTheDocument()
    expect(screen.getByText('build')).toBeInTheDocument()
    expect(screen.getByText('lint')).toBeInTheDocument()
    expect(screen.getByText('ci/circleci')).toBeInTheDocument()
  })

  // One render per test: every mount subscribes to the shared prStatusStore, so a re-hydrate
  // inside a single test would update earlier mounts too and getByText would see duplicates.
  it('renders an open PR as a signal-toned tag', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText('open')).toHaveClass('text-signal')
  })

  it('renders a closed PR as a defect-toned tag', () => {
    prStatusStore.hydrate({ c1: status({ state: 'CLOSED' }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText('closed')).toHaveClass('text-defect')
  })

  it('renders a merged PR as a neutral-toned tag', () => {
    prStatusStore.hydrate({ c1: status({ state: 'MERGED' }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText('merged')).toHaveClass('text-dim')
  })

  it('prefixes the tag with draft and keeps conflicts as side text', () => {
    prStatusStore.hydrate({ c1: status({ isDraft: true, mergeable: 'CONFLICTING' }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText('draft · open')).toBeInTheDocument()
    expect(screen.getByText(/conflicts/)).toBeInTheDocument()
  })

  it('lists checks inside a single divided panel', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const row = screen.getByText('build').closest('div')
    expect(row?.parentElement).toHaveClass('divide-y')
    // all three rows share that one container
    expect(screen.getByText('lint').closest('div')?.parentElement).toBe(row?.parentElement)
  })

  it('offers Analyze only on a failed GitHub Actions check', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByRole('button', { name: 'Analyze build failure' })).toBeEnabled()
    // passed check: no button at all
    expect(screen.queryByRole('button', { name: 'Analyze lint failure' })).not.toBeInTheDocument()
    // failed but not Actions: present and disabled, with a reason
    const third = screen.getByRole('button', { name: 'Analyze ci/circleci failure' })
    expect(third).toBeDisabled()
    expect(third).toHaveAttribute('title', expect.stringMatching(/not a github actions/i))
  })

  it('hands the check name up when Analyze is clicked', async () => {
    const onAnalyze = vi.fn()
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={onAnalyze} />)
    await userEvent.click(screen.getByRole('button', { name: 'Analyze build failure' }))
    expect(onAnalyze).toHaveBeenCalledWith('build')
  })

  it('says so when the PR could not be read, instead of showing stale checks', () => {
    prStatusStore.hydrate({
      c1: status({ rollup: 'unavailable', checks: [], error: 'HTTP 404: Not Found' })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/HTTP 404: Not Found/)).toBeInTheDocument()
    expect(screen.queryByText('build')).not.toBeInTheDocument()
  })

  it('prompts to bind a PR when the case has no cached status', () => {
    prStatusStore.hydrate({})
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/no pull request bound/i)).toBeInTheDocument()
  })

  it('renders every same-named check as its own row — real PRs repeat check names', () => {
    // Observed in the Task 1 capture (see main/services/__tests__/fixtures/README.md): a real PR
    // listed "Semantic Pull Request" twice, another had 46 contexts under 20 names. Keying the
    // list on the name alone would silently drop the duplicates.
    prStatusStore.hydrate({
      c1: status({
        checks: [
          {
            name: 'build',
            bucket: 'fail',
            url: 'https://github.com/acme/widget/actions/runs/1/job/9',
            jobId: 9
          },
          {
            name: 'build',
            bucket: 'pass',
            url: 'https://github.com/acme/widget/actions/runs/2/job/10',
            jobId: 10
          }
        ]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getAllByText('build')).toHaveLength(2)
  })
})
