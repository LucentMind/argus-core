// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PrCompanionSection } from '../PrCompanionSection'
import { prStatusStore } from '../../lib/prStatusStore'
import { confirm } from '../../lib/confirmStore'
import type { PrStatus } from '../../../../shared/prStatus'
import type { PrBinding } from '../../../../shared/pr'

// ConfirmHost (which confirm() talks to) is mounted at the app root (App.tsx), not inside
// PrCompanionSection — mock the store directly, same pattern as CaseWorkspace.test.tsx and
// PrPickerDialog.test.tsx.
vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

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
  vi.mocked(confirm).mockReset().mockResolvedValue(true)
  prStatusStore.hydrate({ c1: status() })
  ;(window as unknown as { argus: unknown }).argus = {
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: () => () => {},
      list: vi.fn(async () => [BINDING]),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      search: vi.fn(async () => ({ candidates: [], error: null, searchedRepos: [] }))
    },
    openExternal: vi.fn(async () => undefined)
  }
})

describe('PrCompanionSection', () => {
  // Product decision (conversation with the user, 2026-07-29): PR-linking controls (Link PR /
  // Find PRs) are reachable only in review mode — "We don't need PR in investigation mode."
  // That is deliberate, not an incidental side effect of this component returning null outside
  // review mode — name the two controls explicitly so a future change that hoists this
  // section's header out from under the `mode !== 'review'` gate (rendering it in every mode)
  // fails with a message that points at the decision, not just "container not empty".
  it('renders nothing outside review mode', () => {
    const { container } = render(
      <PrCompanionSection slug="c1" mode="triage" onAnalyze={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Link PR' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Find PRs' })).not.toBeInTheDocument()
  })

  it('shows decision and checks alongside the subject line', async () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/review required/i)).toBeInTheDocument()
    expect(screen.getByText('build')).toBeInTheDocument()
    expect(screen.getByText('ci/circleci')).toBeInTheDocument()
    // lint passed, so it starts folded behind the disclosure rather than sitting loose. The
    // fixture has no required checks, so groupChecks emits the single unlabelled group — the
    // accessible name has no "in <group>" suffix to name.
    const disclosure = screen.getByRole('button', { name: 'Show 1 passed check' })
    await userEvent.click(disclosure)
    expect(await screen.findByText('lint')).toBeInTheDocument()
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

  // Whether the bound PR has a local checkout governs analyze and checkout flows in review
  // mode — the old ReposSection chip said so via "· no local clone"; PrStatus (what the subject
  // line renders from) carries no repoPath, so the qualifier has to come from the binding.
  it('notes when the bound pull request has no local clone', async () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    // BINDING (the beforeEach default) has repoPath: null; wait for the binding fetch to
    // resolve via a control that only renders once it has (the unlink button).
    await screen.findByRole('button', { name: 'Unlink pull request' })
    expect(screen.getByText('no local clone')).toBeInTheDocument()
  })

  it('omits the no-local-clone note once the bound pull request has a local clone', async () => {
    ;(window.argus as unknown as { pr: { list: ReturnType<typeof vi.fn> } }).pr.list = vi.fn(
      async () => [{ ...BINDING, repoPath: 'C:\\repos\\widget' }]
    )
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    await screen.findByRole('button', { name: 'Unlink pull request' })
    expect(screen.queryByText('no local clone')).not.toBeInTheDocument()
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

  it('puts the empty state where the subject line goes', async () => {
    prStatusStore.hydrate({})
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    // The cache read (statusList) settles asynchronously — isLoaded('c1') is false until then,
    // so the empty message waits rather than claiming "no bound PR" before the cache has spoken.
    expect(await screen.findByText(/no pull request bound/i)).toBeInTheDocument()
    // beforeEach's pr.list resolves a binding even though no status is cached yet — exactly
    // the contradictory state this test used to render without noticing. Flush the binding
    // fetch so this checks the state once it has actually loaded, not just before the promise
    // settles: the unlink control must not show beside a message saying nothing is bound.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole('button', { name: 'Unlink pull request' })).not.toBeInTheDocument()
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

  it('lists checks inside a single container, undivided', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const row = screen.getByText('build').closest('div')
    expect(row?.parentElement?.className ?? '').not.toContain('divide-y')
    // build and ci/circleci (both fail) share that one container; lint (pass) is folded
    expect(screen.getByText('ci/circleci').closest('div')?.parentElement).toBe(row?.parentElement)
  })

  // Only failed checks carry the Analyze button, so anything that lets the button size its row
  // makes failures visibly taller than the checks around them.
  it('lays every visible check row out identically, button or not', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const panel = screen.getByText('build').closest('div')?.parentElement
    // fixture: build (fail+button), ci/circleci (fail) are the visible check rows; lint (pass)
    // is folded behind the "passed" disclosure, itself a third sibling in the same container.
    expect(panel!.children).toHaveLength(3)
    const checkRows = [screen.getByText('build'), screen.getByText('ci/circleci')].map(
      (el) => el.closest('div')!.className
    )
    expect(new Set(checkRows).size).toBe(1)
    expect(checkRows[0]).toContain('h-7')
    // the disclosure is a row too, sized to match rather than standing out
    expect(screen.getByRole('button', { name: /passed/i })).toHaveClass('h-7')
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

  it('renders every same-named check as its own row — real PRs repeat check names', async () => {
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
    // The passing "build" folds behind the disclosure, so only the failing one shows at first —
    // open it before checking that same-named rows are not deduplicated.
    expect(screen.getAllByText('build')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: /passed/i }))
    expect(await screen.findAllByText('build')).toHaveLength(2)
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

  it('leads with the checks that block the merge, under labelled groups', async () => {
    prStatusStore.hydrate({ c1: status({ checks: mixed() }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText(/^required$/i)).toBeInTheDocument()
    expect(screen.getByText(/not blocking merge/i)).toBeInTheDocument()
    // build-mac, lint and codeql all passed, so they start folded — open both groups' disclosures
    // to see the full order.
    for (const btn of screen.getAllByRole('button', { name: /passed/i })) {
      await userEvent.click(btn)
    }
    const names = await screen.findAllByText(/^(lint|build|codeql|build-mac)$/)
    // Required first, GitHub's order preserved inside each group.
    expect(names.map((el) => el.textContent)).toEqual(['build', 'build-mac', 'lint', 'codeql'])
  })

  // With both groups holding passes, a screen-reader user otherwise meets two buttons both
  // named "passed · N" — distinguishable only by the preceding heading, which an accessible
  // name must not depend on.
  it('gives each group’s disclosure a distinct accessible name naming its group', () => {
    prStatusStore.hydrate({ c1: status({ checks: mixed() }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(
      screen.getByRole('button', { name: 'Show 1 passed check in Required' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Show 2 passed checks in Not blocking merge' })
    ).toBeInTheDocument()
  })

  it('keeps every group inside the one check list container, headers included', () => {
    prStatusStore.hydrate({ c1: status({ checks: mixed() }) })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    // Each group nests its own heading and rows; the list of groups itself is the one container.
    const requiredGroup = screen.getByText('build').closest('div')?.parentElement
    const container = requiredGroup?.parentElement
    expect(container?.className ?? '').not.toContain('divide-y')
    expect(screen.getByText(/not blocking merge/i).parentElement?.parentElement).toBe(container)
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

  it('folds each group’s passing checks separately, keeping failures visible', async () => {
    prStatusStore.hydrate({
      c1: status({
        checks: [
          { name: 'gate-fail', bucket: 'fail', required: true, url: null, jobId: null },
          { name: 'gate-pass', bucket: 'pass', required: true, url: null, jobId: null },
          { name: 'extra-pass', bucket: 'pass', required: false, url: null, jobId: null }
        ]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)

    expect(screen.getByText('gate-fail')).toBeInTheDocument()
    expect(screen.queryByText('gate-pass')).not.toBeInTheDocument()
    expect(screen.queryByText('extra-pass')).not.toBeInTheDocument()
    // one disclosure per group that has passing checks — not one for the whole list
    expect(screen.getAllByRole('button', { name: /passed/i })).toHaveLength(2)

    await userEvent.click(screen.getAllByRole('button', { name: /passed/i })[0])
    expect(await screen.findByText('gate-pass')).toBeInTheDocument()
    expect(screen.queryByText('extra-pass')).not.toBeInTheDocument() // other group unaffected
  })

  it('keeps the required / not-blocking headings', () => {
    prStatusStore.hydrate({
      c1: status({
        checks: [
          { name: 'gate', bucket: 'fail', required: true, url: null, jobId: null },
          { name: 'extra', bucket: 'fail', required: false, url: null, jobId: null }
        ]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Required' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Not blocking merge' })).toBeInTheDocument()
  })

  it('does not offer a disclosure when a group has nothing passing', () => {
    prStatusStore.hydrate({
      c1: status({
        checks: [{ name: 'build', bucket: 'fail', required: false, url: null, jobId: null }]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.queryByRole('button', { name: /passed/i })).not.toBeInTheDocument()
  })

  it('dims a skipped check rather than giving it a third result colour', () => {
    prStatusStore.hydrate({
      c1: status({
        checks: [{ name: 'docs-check', bucket: 'skipped', required: false, url: null, jobId: null }]
      })
    })
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    expect(screen.getByText('docs-check').closest('div')).toHaveClass('opacity-50')
  })

  it('separates rows without dividers', () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    const row = screen.getByText('build').closest('div')
    expect(row?.parentElement?.className ?? '').not.toContain('divide-y')
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

  it('does not claim there is no bound PR while the cached status is still loading', async () => {
    prStatusStore.hydrate({})
    let release: (m: Record<string, PrStatus>) => void = () => {}
    window.argus.pr.statusList = vi.fn(
      () =>
        new Promise<Record<string, PrStatus>>((res) => {
          release = res
        })
    )
    render(<PrCompanionSection slug="C-1" mode="review" onAnalyze={vi.fn()} />)

    expect(screen.queryByText(/No pull request bound to this case yet/)).toBeNull()

    await act(async () => {
      release({})
    })
    expect(await screen.findByText(/No pull request bound to this case yet/)).toBeInTheDocument()
  })
})

// Moved from ReposSection.test.tsx's "ReposSection pull requests" block: Link PR / Find PRs
// now live in this section's header instead. beforeEach's default binds acme/widget#42
// (BINDING/status()) — tests that need a case with nothing bound yet override both
// prStatusStore and pr.list before rendering.
describe('PrCompanionSection pull request linking', () => {
  it('links a typed PR reference', async () => {
    prStatusStore.hydrate({})
    window.argus.pr.list = vi.fn(async (): Promise<PrBinding[]> => [])
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
    const box = screen.getByPlaceholderText(/pr url/i)
    fireEvent.change(box, { target: { value: 'acme/widget#42' } })
    fireEvent.submit(box)
    await waitFor(() => expect(window.argus.pr.link).toHaveBeenCalledWith('c1', 'acme/widget#42'))
    // no PR was bound yet, so replacing nothing needs no confirmation
    expect(confirm).not.toHaveBeenCalled()
  })

  // After a successful link, PrCompanionSection must refresh what it owns — the binding (so
  // Unlink targets the right id) and the status (so the subject line/checks appear without a
  // manual refresh click). The first two `pr.list` calls (mount's binding effect, then linkPr's
  // own pre-check) see nothing bound yet; only the post-link refetch sees the new binding.
  it('shows the newly linked pull request without a manual refresh click', async () => {
    prStatusStore.hydrate({})
    let listCalls = 0
    window.argus.pr.list = vi.fn(async (): Promise<PrBinding[]> => {
      listCalls += 1
      return listCalls <= 2 ? [] : [BINDING]
    })
    window.argus.pr.link = vi.fn(async (): Promise<PrBinding> => BINDING)
    window.argus.pr.statusRefresh = vi.fn(async () => ({ c1: status() }))
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
    const box = screen.getByPlaceholderText(/pr url/i)
    fireEvent.change(box, { target: { value: 'acme/widget#42' } })
    fireEvent.submit(box)
    await waitFor(() => expect(window.argus.pr.link).toHaveBeenCalledWith('c1', 'acme/widget#42'))

    // status: prStatusStore.refresh([slug]) hit statusRefresh and merged the result in
    expect(
      await screen.findByRole('button', { name: 'Open pull request acme/widget#42 on GitHub' })
    ).toBeInTheDocument()
    // binding: refetched directly (not left waiting on the status round trip), so Unlink
    // already targets the real id
    expect(screen.getByRole('button', { name: 'Unlink pull request' })).toBeInTheDocument()
  })

  // addBinding replaces rather than adds: linking a second PR over an already-bound one
  // silently retargets any existing findings' comment/push actions unless the user is warned.
  describe('replacing an already-bound PR', () => {
    async function openDraftAndSubmit(value: string): Promise<void> {
      render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
      const box = screen.getByPlaceholderText(/pr url/i)
      fireEvent.change(box, { target: { value } })
      fireEvent.submit(box)
    }

    it('raises a confirm naming the current and new pull request', async () => {
      await openDraftAndSubmit('acme/widget#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('acme/widget#42')
        })
      )
      expect(vi.mocked(confirm).mock.calls[0][0].title).toContain('acme/widget#99')
    })

    it('declining leaves the binding untouched and calls no IPC', async () => {
      vi.mocked(confirm).mockResolvedValue(false)
      await openDraftAndSubmit('acme/widget#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      // give any (incorrect) fire-and-forget link() call a chance to have happened
      await new Promise((r) => setTimeout(r, 0))
      expect(window.argus.pr.link).not.toHaveBeenCalled()
    })

    it('accepting proceeds to link the new pull request', async () => {
      vi.mocked(confirm).mockResolvedValue(true)
      await openDraftAndSubmit('acme/widget#99')
      await waitFor(() => expect(window.argus.pr.link).toHaveBeenCalledWith('c1', 'acme/widget#99'))
    })

    // Re-review fix: `linkingPr` (and so the disabled input) now gates BEFORE the confirm
    // await, matching the restructuring PrPickerDialog's `confirm()` got this round — a
    // double-click could otherwise race the await and raise the confirm dialog twice.
    it('disables the input while the replace-confirm itself is pending, not just the link', async () => {
      let resolveConfirm!: (v: boolean) => void
      vi.mocked(confirm).mockImplementation(() => new Promise((r) => (resolveConfirm = r)))
      await openDraftAndSubmit('acme/widget#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      expect(screen.getByPlaceholderText(/linking/i)).toBeDisabled()

      resolveConfirm(true)
      await waitFor(() => expect(window.argus.pr.link).toHaveBeenCalledWith('c1', 'acme/widget#99'))
    })
  })

  // Re-review fix: retyping the ALREADY-bound PR (a no-op for addBinding, which is
  // idempotent on identity) must not scare the user with a "replace" warning about
  // findings retargeting — nothing retargets when the identity doesn't change.
  describe('re-linking the SAME pull request', () => {
    async function openDraftAndSubmit(value: string): Promise<void> {
      render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
      const box = screen.getByPlaceholderText(/pr url/i)
      fireEvent.change(box, { target: { value } })
      fireEvent.submit(box)
    }

    it('no confirm for the canonical url spelling', async () => {
      await openDraftAndSubmit(BINDING.url)
      await waitFor(() => expect(window.argus.pr.link).toHaveBeenCalledWith('c1', BINDING.url))
      expect(confirm).not.toHaveBeenCalled()
    })

    it('no confirm for the owner/repo#n spelling', async () => {
      await openDraftAndSubmit('acme/widget#42')
      await waitFor(() => expect(window.argus.pr.link).toHaveBeenCalledWith('c1', 'acme/widget#42'))
      expect(confirm).not.toHaveBeenCalled()
    })

    it('still confirms a spelling of a genuinely different pull request', async () => {
      await openDraftAndSubmit('acme/widget#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    })
  })

  // Re-review fix: pr:link now runs a git fetch + worktree add unconditionally (see
  // prLink.ts), not just a DB write — the input must show it is busy and refuse a second
  // submit while the first is still in flight.
  it('disables the input while a link is in flight and re-enables after', async () => {
    // nothing bound yet, so linkPr proceeds straight to pr.link with no confirm in the way
    prStatusStore.hydrate({})
    window.argus.pr.list = vi.fn(async (): Promise<PrBinding[]> => [])
    let resolveLink: ((binding: PrBinding) => void) | undefined
    window.argus.pr.link = vi.fn(
      () =>
        new Promise<PrBinding>((resolve) => {
          resolveLink = resolve
        })
    )
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
    const box = screen.getByPlaceholderText(/pr url/i)
    fireEvent.change(box, { target: { value: 'acme/widget#42' } })
    fireEvent.submit(box)
    await waitFor(() => expect(box).toBeDisabled())

    // a second submit while linking is in flight must not fire a second IPC call
    fireEvent.change(box, { target: { value: 'acme/widget#77' } })
    fireEvent.submit(box)
    expect(window.argus.pr.link).toHaveBeenCalledTimes(1)

    // a successful link clears the draft and closes the form (setPrDraft(null)), so the
    // input itself unmounts — assert re-enablement indirectly via the form disappearing
    // rather than the (by-then-detached) input node.
    resolveLink!(BINDING)
    await waitFor(() => expect(screen.queryByPlaceholderText(/pr url/i)).toBeNull())
  })

  // The only way to reopen the picker once PRs are bound, and the recovery path for a
  // search that failed or found nothing.
  it('re-runs the search on demand and hands the result to the picker', async () => {
    const onFound = vi.fn()
    const result = { candidates: [], error: null, searchedRepos: ['acme/widget'] }
    window.argus.pr.search = vi.fn(async () => result)
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} onPrsFound={onFound} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Find PRs' }))
    await waitFor(() => expect(window.argus.pr.search).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(onFound).toHaveBeenCalledWith(result))
  })

  // The Find PRs button is opt-in (only rendered when the parent hands a handler), same as
  // it was on ReposSection — a caller with no picker to open should not show a dead control.
  it('omits Find PRs when no onPrsFound handler is supplied', async () => {
    render(<PrCompanionSection slug="c1" mode="review" onAnalyze={() => {}} />)
    await screen.findByRole('button', { name: 'Link PR' })
    expect(screen.queryByRole('button', { name: 'Find PRs' })).toBeNull()
  })
})
