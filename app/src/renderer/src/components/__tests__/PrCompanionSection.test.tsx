// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PrCompanionSection } from '../PrCompanionSection'
import { prStatusStore } from '../../lib/prStatusStore'
import type { PrStatus } from '../../../../shared/prStatus'
import type { PrBinding } from '../../../../shared/pr'

const status = (over: Partial<PrStatus> = {}): PrStatus => ({
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'REVIEW_REQUIRED',
  rollup: 'failing',
  checks: [
    {
      name: 'build',
      bucket: 'fail',
      required: false,
      url: 'https://github.com/acme/widget/actions/runs/1/job/9',
      jobId: 9
    },
    { name: 'lint', bucket: 'pass', required: false, url: null, jobId: null },
    {
      name: 'ci/circleci',
      bucket: 'fail',
      required: false,
      url: 'https://circleci.com/x',
      jobId: null
    }
  ],
  fetchedAt: '2026-07-27T12:00:00.000Z',
  error: null,
  ...over
})

const BINDING: PrBinding = {
  id: 3,
  caseId: 1,
  repoPath: null,
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
  source: 'search',
  detectedAt: '2026-07-29T00:00:00Z'
}

beforeEach(() => {
  prStatusStore.hydrate({ c1: status() })
  ;(window as unknown as { argus: unknown }).argus = {
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: () => () => {},
      list: vi.fn(async () => [BINDING]),
      unlink: vi.fn(async () => undefined)
    },
    openExternal: vi.fn(async () => undefined)
  }
})

describe('PrCompanionSection', () => {
  it('renders nothing outside review mode', () => {
    const { container } = render(
      <PrCompanionSection slug="c1" mode="triage" onAnalyze={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows decision and checks alongside the subject line', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/review required/i)).toBeInTheDocument()
    expect(screen.getByText('build')).toBeInTheDocument()
    expect(screen.getByText('lint')).toBeInTheDocument()
    expect(screen.getByText('ci/circleci')).toBeInTheDocument()
  })

  it('names the PR as the section subject and opens it', async () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const ref = await screen.findByRole('button', {
      name: 'Open pull request acme/widget#42 on GitHub'
    })
    await userEvent.click(ref)
    expect(window.argus.openExternal).toHaveBeenCalledWith('https://github.com/acme/widget/pull/42')
  })

  it('offers unlink from the section header once a binding is loaded', async () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink pull request' }))
    expect(window.argus.pr.unlink).toHaveBeenCalledWith('c1', 3)
  })

  // beforeEach stubs statusRefresh to return {} — exactly what the real service does for a case
  // with no binding (refreshPrStatuses skips it rather than caching empty). That's what exposed
  // the bug: refresh([slug]) after unlink left the stale cached status in place because
  // prStatusStore.merge() no-ops on an empty incoming map.
  it('returns to the empty state once the pull request is unlinked', async () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink pull request' }))
    expect(
      screen.queryByRole('button', { name: 'Open pull request acme/widget#42 on GitHub' })
    ).not.toBeInTheDocument()
    expect(await screen.findByText(/no pull request bound/i)).toBeInTheDocument()
  })

  it('puts the empty state where the subject line goes', () => {
    prStatusStore.hydrate({})
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/no pull request bound/i)).toBeInTheDocument()
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

  it('puts the state tag beside the PR identity, not the header', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText('open').parentElement?.textContent).toContain('acme/widget#42')
  })

  it('lists checks inside a single divided panel', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const row = screen.getByText('build').closest('div')
    expect(row?.parentElement).toHaveClass('divide-y')
    // all three rows share that one container
    expect(screen.getByText('lint').closest('div')?.parentElement).toBe(row?.parentElement)
  })

  // Only failed checks carry the Analyze button, so anything that lets the button size its row
  // makes failures visibly taller than the checks around them.
  it('lays every check row out identically, button or not', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const panel = screen.getByText('build').closest('div')?.parentElement
    const rowClasses = new Set(Array.from(panel!.children).map((r) => r.className))
    expect(panel!.children).toHaveLength(3) // build (fail+button), lint (pass), ci/circleci (fail)
    expect(rowClasses.size).toBe(1)
    expect([...rowClasses][0]).toContain('h-7')
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
            required: false,
            url: 'https://github.com/acme/widget/actions/runs/1/job/9',
            jobId: 9
          },
          {
            name: 'build',
            bucket: 'pass',
            required: false,
            url: 'https://github.com/acme/widget/actions/runs/2/job/10',
            jobId: 10
          }
        ]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getAllByText('build')).toHaveLength(2)
  })

  it('marks a cancelled check apart from a failure and offers it no Analyze button', () => {
    prStatusStore.hydrate({
      c1: status({
        checks: [
          {
            name: 'pylint',
            bucket: 'cancelled',
            required: false,
            url: 'https://github.com/acme/widget/actions/runs/1/job/9',
            jobId: 9
          }
        ]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText('⊘')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Analyze pylint failure' })).not.toBeInTheDocument()
  })

  const mixed = (): PrStatus['checks'] => [
    { name: 'lint', bucket: 'pass', required: false, url: null, jobId: null },
    { name: 'build', bucket: 'fail', required: true, url: null, jobId: null },
    { name: 'codeql', bucket: 'pass', required: false, url: null, jobId: null },
    { name: 'build-mac', bucket: 'pass', required: true, url: null, jobId: null }
  ]

  it('leads with the checks that block the merge, under labelled groups', () => {
    prStatusStore.hydrate({ c1: status({ checks: mixed() }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/^required$/i)).toBeInTheDocument()
    expect(screen.getByText(/not blocking merge/i)).toBeInTheDocument()
    const names = screen.getAllByText(/^(lint|build|codeql|build-mac)$/).map((el) => el.textContent)
    // Required first, GitHub's order preserved inside each group.
    expect(names).toEqual(['build', 'build-mac', 'lint', 'codeql'])
  })

  it('keeps every row in the one divided panel, headers included', () => {
    prStatusStore.hydrate({ c1: status({ checks: mixed() }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const panel = screen.getByText('build').closest('div')?.parentElement
    expect(panel).toHaveClass('divide-y')
    expect(screen.getByText(/not blocking merge/i).parentElement).toBe(panel)
  })

  it('exposes the group labels as headings, not loose text', () => {
    prStatusStore.hydrate({ c1: status({ checks: mixed() }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByRole('heading', { name: /^required$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /not blocking merge/i })).toBeInTheDocument()
  })

  it('says the merge is blocked when GitHub says so', () => {
    prStatusStore.hydrate({ c1: status({ mergeStateStatus: 'BLOCKED' }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/merge blocked/i)).toBeInTheDocument()
  })

  it('says nothing about the merge state when it is clean', () => {
    prStatusStore.hydrate({
      c1: status({ mergeStateStatus: 'CLEAN', reviewDecision: null })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.queryByText(/merge blocked/i)).not.toBeInTheDocument()
  })

  it('shows no group headers when nothing is required', () => {
    // A repository with no branch protection has no required checks. A lone "not blocking
    // merge" header over the whole list would read as a claim about policy rather than the
    // absence of one, so that case stays the flat list it is today.
    prStatusStore.hydrate({ c1: status() })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.queryByText(/not blocking merge/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^required$/i)).not.toBeInTheDocument()
  })

  it('summarises the checks by bucket, leading with failures', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    // fixture: build (fail), lint (pass), ci/circleci (fail)
    expect(screen.getByText(/2 failing/)).toBeInTheDocument()
    expect(screen.getByText(/1 passed/)).toBeInTheDocument()
  })

  it('counts cancelled checks rather than dropping them', () => {
    prStatusStore.hydrate({
      c1: status({
        checks: [
          { name: 'a', bucket: 'cancelled', required: false, url: null, jobId: null },
          { name: 'b', bucket: 'pass', required: false, url: null, jobId: null }
        ]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/1 cancelled/)).toBeInTheDocument()
  })

  it('keeps the rollup dot — it says whether failures gate the merge, which a count cannot', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    // PrRollupDot renders role="img" with a state-specific name (PrRollupDot.tsx:10-22).
    expect(screen.getByRole('img', { name: 'Checks failing' })).toBeInTheDocument()
  })
})
