// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TopBar } from '../TopBar'
import { uiStore } from '../../lib/uiStore'
import { caseBarStore } from '../../lib/caseBarStore'
import { viewTitleStore } from '../../lib/viewTitleStore'
import { proposalsStore } from '../../lib/proposalsStore'
import { currencyStore } from '../../lib/currencyStore'
import { noticeStore } from '../../lib/noticeStore'
import { AmbientAnchorContext } from '../../lib/ambientAnchors'
import type { CaseRecord } from '../../../../shared/types'
import type { DistillJobRow } from '../../../../shared/distill'
import type { CurrencyPayload } from '../../../../shared/currency'

const CASE = {
  id: 1,
  slug: 'NAV-1',
  title: 'NAV-1',
  status: 'open',
  resolution: null,
  jiraKey: null,
  jiraSyncedAt: null,
  jiraPriority: null,
  activeMode: 'investigation'
} as unknown as CaseRecord

beforeEach(() => {
  localStorage.clear()
  for (const t of [...uiStore.get().recentTabs]) uiStore.closeTab(t)
  if (uiStore.get().theme !== 'dark') uiStore.setTheme('dark')
  if (!uiStore.get().showToolCalls) uiStore.setShowToolCalls(true)
  caseBarStore.reset()
  viewTitleStore.reset()
  proposalsStore.reset()
  // currencyStore is a module singleton (Task 2); localStorage.clear() above does not touch it,
  // so a leftover `blocked` list from one test would bleed the Settings badge into the next.
  currencyStore.reset()
  // Same reason: HeaderNotice reads this module singleton directly, not through a prop.
  noticeStore.reset()
  uiStore.setDynamicTheme(false)
  window.argus = {
    modes: { available: vi.fn(async () => ['investigation', 'review']) },
    distill: { status: vi.fn(async () => null), onChanged: vi.fn(() => () => {}) },
    proposals: {
      list: vi.fn(async () => ({ proposals: [] })),
      onChanged: vi.fn(() => () => {})
    },
    currency: {
      get: vi.fn(async () => ({ auto: true, lastSurveyAt: null, blocked: [], busy: false })),
      onChanged: vi.fn(() => () => {}),
      onAdopted: vi.fn(() => () => {}),
      ackAdopted: vi.fn(async () => {})
    },
    cases: {
      setStatus: vi.fn(async () => undefined),
      setMode: vi.fn(async () => ({ sessionId: 9 }))
    },
    bundle: { export: vi.fn(async () => ({ ok: true, fileCount: 1 })) },
    jira: { refreshCase: vi.fn(), openIssue: vi.fn() },
    platform: 'win32',
    window: {
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
      onMaximizedChanged: vi.fn(() => () => {})
    }
  } as never
})

describe('TopBar', () => {
  // Tabs are a case-view control (user-directed, 2026-08-02). On home the grid below already IS
  // the case list, and in Settings there is no case in view to switch between — the band was a
  // second, lesser copy of navigation each of those views owns. `activeSlug` is null on exactly
  // those two, which is why the same flag gates the band and the case group.
  it('hides the tab band outside a case, without forgetting the tabs', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    const { rerender } = render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(screen.queryByRole('navigation', { name: 'Recent cases' })).toBeNull()
    // Hidden, not dropped: the tabs live in uiStore, so opening a case brings the whole band
    // back as it was rather than rebuilding it one visit at a time.
    rerender(
      <TopBar
        activeSlug="NAV-1"
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    expect(nav.textContent).toContain('NAV-2')
  })

  // The band itself is RecentTabs' (see its own suite); what the bar owes is mounting it with
  // this bar's active case and select handler.
  it('renders recent-case tabs and selects on click', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    const onSelect = vi.fn()
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={null}
        onHome={vi.fn()}
        onSelect={onSelect}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('NAV-2'))
    expect(onSelect).toHaveBeenCalledWith('NAV-2')
  })

  // Theme lives in Settings only now (user-directed, 2026-08-08) — the bar carries no
  // dark/light control of its own to flip.
  it('carries no theme control of its own', () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /switch to (light|dark) theme/i })).toBeNull()
    // the tool-call toggle moved to the composer control row
    expect(screen.queryByRole('button', { name: /tool calls/i })).toBeNull()
  })

  it('brand button goes home', () => {
    const onHome = vi.fn()
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={onHome}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'All cases' }))
    expect(onHome).toHaveBeenCalled()
  })

  // The wordmark lives here and only here — home and Settings dropped their own copies, so a
  // regression that split these back into two controls would leave the app unbranded.
  it('carries the wordmark inside the home button, not beside it', () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const home = screen.getByRole('button', { name: 'All cases' })
    expect(home.textContent).toContain('ARGUS')
    expect(screen.getAllByText('ARGUS')).toHaveLength(1)
  })

  it('gear button fires onSettings', () => {
    const onSettings = vi.fn()
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={onSettings}
        onStatusChanged={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSettings).toHaveBeenCalled()
  })

  it('renders the Proposals button and fires onProposals', () => {
    const onProposals = vi.fn()
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
        onProposals={onProposals}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Proposals' }))
    expect(onProposals).toHaveBeenCalled()
  })

  // The Related history glyph is lucide's `timeline`, not `history` (user-directed, 2026-08-08).
  // Pinned by lucide's own generated class — an icon swap is otherwise invisible to every test.
  it('draws Related history with the timeline icon', () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
        onRelatedHistory={vi.fn()}
      />
    )
    const svg = screen.getByRole('button', { name: 'Related history' }).querySelector('svg')
    expect(svg?.getAttribute('class')).toContain('lucide-timeline')
  })

  it('shows the pending-count pill only when counts are positive', async () => {
    window.argus.proposals.list = vi.fn(async () => ({
      proposals: [{ type: 'reference-edit' }, { type: 'reference-edit' }, { type: 'skill-new' }]
    })) as never
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
        onProposals={vi.fn()}
      />
    )
    expect(await screen.findByText('3')).toBeInTheDocument()
  })

  it('hides the pending-count pill when there are no pending proposals', async () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
        onProposals={vi.fn()}
      />
    )
    await screen.findByRole('button', { name: 'Proposals' })
    await vi.waitFor(() => expect(window.argus.proposals.list).toHaveBeenCalled())
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('is a drag region, with every interactive element opted out', async () => {
    uiStore.openTab('NAV-1')
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const header = screen.getByRole('banner')
    expect(header.classList.contains('argus-drag')).toBe(true)
    // Not `.argus-titlebar-inset`: that class reserves room beside a *native* OS button
    // cluster, and this header draws its own buttons (WindowControls) — `.argus-header-inset`
    // is the rule that exists for that instead.
    expect(header.classList.contains('argus-titlebar-inset')).toBe(false)

    // ModeSwitcher renders a plain <span> until window.argus.modes.available resolves; wait
    // for the real buttons so they are part of what this test checks, not silently absent.
    await screen.findByRole('button', { name: 'Case mode · Review' })

    // A drag region swallows clicks AND scroll, so everything the user operates has to opt out.
    const interactive = header.querySelectorAll('button, a, input, select, textarea, [tabindex]')
    expect(interactive.length).toBeGreaterThan(5)
    // Chromium computes draggable regions as a stack of rects: a `no-drag` rect subtracts
    // from the enclosing `drag` rect, and everything inside it is out of the drag region.
    // `closest`, not a per-element class check, so the case group can opt out with one
    // container instead of threading a bar-specific class through six components that are
    // not about the bar. Verified live, not here — jsdom implements no app-region.
    for (const el of interactive) {
      expect(el.closest('.argus-nodrag')).not.toBeNull()
    }
  })

  it('renders no case group without an active case', () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(screen.queryByTestId('case-group')).toBeNull()
  })

  it('keeps the active case in the anchor and out of the strip', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    // printed once, in the anchor — printing it in both places is the duplication this
    // whole change exists to remove
    expect(screen.getAllByText('NAV-1')).toHaveLength(1)
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    expect(nav.textContent).not.toContain('NAV-1')
    expect(nav.textContent).toContain('NAV-2')
    expect(screen.getByTestId('case-group').textContent).toContain('NAV-1')
    // the anchor has no × — Close case in its menu is the replacement
    expect(screen.queryByRole('button', { name: 'Close NAV-1' })).toBeNull()
  })

  // The bar's whole layout rule, and a regression pin for the defect it replaced: the tab band
  // used to place itself with `ml-[50%]`, and because a percentage margin cannot flex, a wide
  // case group plus that margin pushed the action icons clean off the right edge of the window.
  // The band is bounded by the right group instead — capped at half the bar (so it can never
  // reach into the case group's half) and free to shrink to nothing (so the icons, `shrink-0`
  // inside that same group, stay visible at every width).
  it('bounds the tab band with the icon group, so the icons can never be pushed out', () => {
    uiStore.openTab('NAV-2')
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    expect(nav.className).toContain('overflow-x-auto')
    expect(nav.className).toContain('flex-1')
    // no percentage margin in the band itself — that is the defect
    expect(nav.className).not.toMatch(/\bml-\[/)

    const group = nav.parentElement!
    expect(group.className).toContain('max-w-[50%]')
    expect(group.className).toContain('min-w-0')
    expect(group.className).toContain('ml-auto')

    // the icon lives in that same group, after the band, and never gives up width
    for (const name of ['Settings']) {
      const btn = screen.getByRole('button', { name })
      expect(btn.parentElement, `${name} must sit in the bounded right group`).toBe(group)
      expect(btn.className, `${name} must not shrink`).toContain('shrink-0')
    }
    expect(screen.getByTestId('case-group').className).toContain('shrink-0')
  })

  it('publishes a mode switch through the store instead of a prop', async () => {
    const user = userEvent.setup()
    const seen = vi.fn()
    const off = caseBarStore.onEventFor('NAV-1', seen)
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    await user.click(await screen.findByRole('button', { name: 'Case mode · Review' }))
    await vi.waitFor(() =>
      expect(seen).toHaveBeenCalledWith({
        kind: 'mode-switched',
        slug: 'NAV-1',
        mode: 'review',
        sessionId: 9
      })
    )
    off()
  })

  // "reads busy state back off the store" and "ignores busy state published for a different
  // case" lived here. Both tested `caseBarStore`'s state channel, which is gone: it existed
  // only so review's PR search could keep this button spinning, and that search now reports in
  // the Pull request rail. The cross-case leak the second one guarded cannot recur — the
  // replacement is a prop from CaseWorkspace to a `key={`pr:${slug}`}` PrCompanionSection, so
  // it is per-case by construction rather than by a slug check. The event channel this file
  // still covers above is untouched.

  // DistillChip is keyed on `activeSlug` (TopBar.tsx) specifically so a retry clicked on one
  // case cannot survive a switch to another — TopBar itself is not remounted on a case switch,
  // only re-rendered with a new `activeSlug`. The hazard is a retry that resolves *after* the
  // switch: without the key, the same DistillChip instance is still alive under the new slug
  // and adopts case A's stale retry result. Delete the key and this is the test that must fail.
  it('does not let a case retry survive a switch to another case (DistillChip key guard)', async () => {
    const user = userEvent.setup()
    const CASE2 = { ...CASE, slug: 'NAV-2', title: 'NAV-2' } as unknown as CaseRecord
    const failedJob: DistillJobRow = {
      id: 1,
      caseSlug: 'NAV-1',
      state: 'failed',
      error: 'boom',
      itemCount: null,
      createdAt: '',
      finishedAt: null,
      costUsd: null,
      turnCount: null,
      toolCallCount: null,
      promptChars: null,
      dryRun: false
    }
    const runningJob: DistillJobRow = { ...failedJob, state: 'running' }
    window.argus.distill.status = vi.fn(async (slug: string) =>
      slug === 'NAV-1' ? failedJob : null
    )
    let resolveRetry!: (job: DistillJobRow) => void
    window.argus.distill.retry = vi.fn(
      () =>
        new Promise<DistillJobRow>((resolve) => {
          resolveRetry = resolve
        })
    )

    const view = render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )

    await user.click(await screen.findByRole('button', { name: 'distill failed — retry' }))

    // Switch cases while case A's retry is still in flight — the request outlives the switch,
    // the same class of hazard finding 4 addresses for the review PR search.
    view.rerender(
      <TopBar
        activeSlug="NAV-2"
        activeCase={CASE2}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    await vi.waitFor(() => expect(screen.queryByText('distill failed — retry')).toBeNull())

    // Case A's retry resolves only now, after the switch. With the key, the DistillChip that
    // requested it was already unmounted, so this result lands nowhere. Without the key, the
    // still-alive instance would adopt it and show case A's outcome under case B.
    await act(async () => {
      resolveRetry(runningJob)
    })
    expect(screen.queryByText(/^distilling/)).toBeNull()
  })

  // CaseAnchor is keyed on `activeSlug` for the identical reason DistillChip is (see the test
  // above): TopBar itself is not remounted on a case switch, only re-rendered with a new
  // `activeSlug`. Unlike the DistillChip case, this shape is reachable even when NEITHER the old
  // nor the new slug has ever had a distill job — `tracked` stays `null` across the switch, so
  // there is no identity change for CaseAnchor's own epoch guard to key off. Without the `key`,
  // case A's redistill() response resolving after the switch would be adopted into case B's row
  // as "Cancel distillation" carrying case A's job id — and clicking it would call cancel() on
  // case A's job from case B's menu. Delete the key and this is the test that must fail.
  it('does not let a case redistill response survive a switch to another case (CaseAnchor key guard)', async () => {
    const user = userEvent.setup()
    const CASE2 = { ...CASE, slug: 'NAV-2', title: 'NAV-2' } as unknown as CaseRecord
    window.argus.distill.status = vi.fn(async () => null) // neither case has ever had a job
    let resolveRedistill!: (job: DistillJobRow) => void
    window.argus.distill.redistill = vi.fn(
      () =>
        new Promise<DistillJobRow>((resolve) => {
          resolveRedistill = resolve
        })
    )
    window.argus.distill.cancel = vi.fn()

    const view = render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )

    await user.click(await screen.findByRole('button', { name: 'Case actions · NAV-1' }))
    await user.click(screen.getByText('Distill').closest('button')!)
    expect(window.argus.distill.redistill).toHaveBeenCalledWith('NAV-1')

    // Switch cases while NAV-1's redistill() is still in flight.
    view.rerender(
      <TopBar
        activeSlug="NAV-2"
        activeCase={CASE2}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Case actions · NAV-1' })).toBeNull()
    )

    // NAV-1's redistill() resolves only now, after the switch. With the key, the CaseAnchor
    // instance that requested it was already unmounted, so this result lands nowhere. Without
    // the key, the still-alive instance would adopt it under NAV-2's identity.
    await act(async () => {
      resolveRedistill({
        id: 1,
        caseSlug: 'NAV-1',
        state: 'running',
        error: null,
        itemCount: null,
        createdAt: '',
        finishedAt: null,
        costUsd: null,
        turnCount: null,
        toolCallCount: null,
        promptChars: null,
        dryRun: false
      })
    })

    await user.click(await screen.findByRole('button', { name: 'Case actions · NAV-2' }))
    expect(screen.queryByText('Cancel distillation')).toBeNull()
    expect(screen.getByText('Distill')).toBeTruthy()
  })

  it('leaves the case group unscoped when the dynamic theme is off', () => {
    uiStore.setDynamicTheme(false)
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={{ ...CASE, jiraPriority: 'Highest' } as never}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const group = screen.getByTestId('case-group')
    expect(group.className).not.toContain('dyn')
    expect(group.hasAttribute('data-tier')).toBe(false)
  })

  it('scopes the case group itself, since TopBar renders outside DynamicScope', () => {
    uiStore.setDynamicTheme(true)
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={{ ...CASE, jiraPriority: 'Highest' } as never}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const group = screen.getByTestId('case-group')
    expect(group.className).toContain('dyn-case-bar')
    // `dyn` and `dyn-case` carry the token block and the variant rules respectively; without
    // both, the group resolves the classic tokens and seams against the case body.
    expect(group.classList.contains('dyn')).toBe(true)
    expect(group.classList.contains('dyn-case')).toBe(true)
    expect(group.getAttribute('data-tier')).toBe('p1')
  })

  it('keeps the priority tint inside the case group, never on the bar', () => {
    uiStore.setDynamicTheme(true)
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={{ ...CASE, jiraPriority: 'Highest' } as never}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    // The bar renders on Home and Settings too, where an active case's Jira priority has no
    // business tinting the app chrome.
    expect(screen.getByRole('banner').hasAttribute('data-tier')).toBe(false)
  })

  it('carries the caption buttons on win32, flush into the corner', () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(screen.getByTestId('window-close')).toBeInTheDocument()
    const header = screen.getByRole('banner')
    expect(header.className).toContain('pr-0')
    expect(header.className).toContain('argus-header-inset')
    // NOT the strip's class: that one also reserves right-hand space for a native cluster.
    expect(header.className).not.toContain('argus-titlebar-inset')
  })

  it('keeps its right padding on darwin, where it draws no buttons', () => {
    window.argus = { ...window.argus, platform: 'darwin' } as never
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(screen.queryByTestId('window-close')).not.toBeInTheDocument()
    expect(screen.getByRole('banner').className).toContain('pr-3')
  })

  it('renders the settings page identity when Settings publishes one', async () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(screen.queryByTestId('view-title')).not.toBeInTheDocument()
    act(() => viewTitleStore.publish({ label: 'General', blurb: 'Appearance and shell.' }))
    const title = screen.getByTestId('view-title')
    expect(title).toHaveTextContent('General')
    // The blurb has no line of its own any more (user-directed, 2026-08-02) — it is the title's
    // tooltip, which is now the only place the longer description is reachable. Asserted as an
    // absence as well as a presence: a second line reappearing would grow the header on
    // navigation, which is the thing the single-line rule has always been about.
    expect(screen.queryByTestId('settings-blurb')).not.toBeInTheDocument()
    expect(title.getAttribute('title')).toBe('Appearance and shell.')
    expect(title.className).toContain('truncate')
    act(() => viewTitleStore.publish(null))
    expect(screen.queryByTestId('view-title')).not.toBeInTheDocument()
  })

  // Proposals and Related history publish here too (user-directed, 2026-08-08) — they used to
  // carry a title row of their own under the header, which is now deleted. A live count rides
  // alongside the title but OUTSIDE it, so the ambient light anchor stays the title's own box.
  it('renders a published detail beside the title, outside the light anchor', () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    act(() => viewTitleStore.publish({ label: 'Proposals', detail: '· 5 pending' }))
    const title = screen.getByTestId('view-title')
    expect(title).toHaveTextContent('Proposals')
    expect(title).not.toHaveTextContent('pending')
    expect(screen.getByText('· 5 pending')).toBeInTheDocument()
    // No detail published (Settings, Related history) means no second span at all.
    act(() => viewTitleStore.publish({ label: 'Related history' }))
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument()
  })

  // The title lines up with the settings CONTENT column, not with whatever is to its left in the
  // bar — SettingsView's `w-48` rail plus the page's `p-8` put that column's edge at 14rem.
  //
  // The offset is a main.css class, not a utility, because it has to subtract the header's own
  // `.argus-header-inset` padding back out: an absolutely positioned box sits against its
  // containing block's PADDING box, so a plain 14rem lands 12px too far right. jsdom computes no
  // `env()`, so this pins the coupling by class name — which is the part that silently rots if
  // either the rail width or the header inset moves.
  it('aligns the settings title with the content column and keeps it out of the flex row', () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    act(() => viewTitleStore.publish({ label: 'General', blurb: 'Appearance and shell.' }))
    const box = screen.getByTestId('view-title').parentElement!
    expect(box.className).toContain('argus-view-masthead')
    // Absolute, so a long page label cannot push the tab band or the action icons rightward —
    // in flow it would compete with them for the bar's width.
    expect(box.className).toContain('absolute')
    // No `left-*` utility: the offset is the CSS class's job, and a utility here would be the
    // 12px-off version this replaced.
    expect(box.className).not.toMatch(/\bleft-/)
  })

  // Regression pin for what shipped alongside the case-only tab band: the right group kept
  // `flex-1 max-w-[50%]`, which are BOUNDING rules for a band that is no longer there. With
  // nothing elastic inside it the group still stretched to half the bar, and the `shrink-0` icons
  // sat at its leading edge — stranded in the middle of the window instead of in the corner.
  it('keeps the action icons in the corner when there is no tab band to bound', () => {
    uiStore.openTab('NAV-2')
    const { rerender } = render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const group = (): HTMLElement => screen.getByRole('button', { name: 'Settings' }).parentElement!
    // Content-sized: ml-auto alone puts it flush right.
    expect(group().className).toContain('ml-auto')
    expect(group().className).not.toContain('flex-1')
    expect(group().className).not.toContain('max-w-[50%]')

    // ...and the bounding rules come back with the band, since that is what they bound.
    rerender(
      <TopBar
        activeSlug="NAV-1"
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(group().className).toContain('flex-1')
    expect(group().className).toContain('max-w-[50%]')
  })

  // A divider needs content on both sides. It used to render on every view, which left a hairline
  // beside the wordmark dividing it from nothing on home and in Settings — Settings' title being
  // absolutely positioned and out of that flow entirely.
  it('only draws the wordmark divider when the case group is there to divide from', () => {
    const { container, rerender } = render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const dividers = (): number => container.querySelectorAll('.w-px').length
    expect(dividers()).toBe(0)
    act(() => viewTitleStore.publish({ label: 'General', blurb: 'Appearance and shell.' }))
    expect(dividers()).toBe(0)

    act(() => viewTitleStore.publish(null))
    rerender(
      <TopBar
        activeSlug="NAV-1"
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(dividers()).toBeGreaterThan(0)
  })

  it('goes transparent and rises above the ambient layer when the dynamic theme is on', () => {
    uiStore.setDynamicTheme(true)
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const header = screen.getByRole('banner')
    // The canvas is `position: fixed; z-index: 0`, which paints above every non-positioned
    // sibling — so the header has to be positioned and above it.
    expect(header.className).toContain('relative')
    expect(header.className).toContain('z-20')
    // and it must not paint its own ground over the flow
    expect(header.className).not.toContain('bg-void')
    expect(header.className).not.toContain('border-b')
  })

  it('keeps its own ground and border with the dynamic theme off', () => {
    uiStore.setDynamicTheme(false)
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const header = screen.getByRole('banner')
    expect(header.className).toContain('bg-void')
    expect(header.className).toContain('border-b')
  })

  it('is the ambient light source and cutoff while Settings is up', () => {
    // Doubles return a cleanup, matching the claim/release contract (lib/ambientAnchors.ts) that
    // 'releases the anchors on leaving Settings' below exercises directly — this test only
    // asserts attach, but a bare `vi.fn()` here would type-check anyway (its inferred return is
    // `any`), so keeping the shape honest is what makes a future contract-violating double fail.
    const setLight = vi.fn(() => () => {})
    const setCutoff = vi.fn(() => () => {})
    render(
      <AmbientAnchorContext.Provider value={{ setLight, setCutoff }}>
        <TopBar
          activeSlug={null}
          activeCase={null}
          onHome={vi.fn()}
          onSelect={vi.fn()}
          onSettings={vi.fn()}
          onStatusChanged={vi.fn()}
        />
      </AmbientAnchorContext.Provider>
    )
    // Outside Settings the header owns neither anchor.
    expect(setCutoff).not.toHaveBeenCalledWith(expect.any(HTMLElement))
    act(() => viewTitleStore.publish({ label: 'General', blurb: 'Appearance.' }))
    expect(setCutoff).toHaveBeenCalledWith(screen.getByRole('banner'))
    expect(setLight).toHaveBeenCalledWith(screen.getByTestId('view-title'))
  })

  it('releases the anchors on leaving Settings', () => {
    // The anchor refs are React 19 cleanup refs (lib/ambientAnchors.ts): returning a function from
    // a ref callback makes React call THAT on detach instead of re-calling the ref with `null`.
    // So "released" is observed as the cleanup running, not as a `null` argument — and these
    // doubles have to return one, or they would exercise the legacy path the app no longer uses.
    const released: string[] = []
    const setLight = vi.fn(() => () => released.push('light'))
    const setCutoff = vi.fn(() => () => released.push('cutoff'))
    render(
      <AmbientAnchorContext.Provider value={{ setLight, setCutoff }}>
        <TopBar
          activeSlug={null}
          activeCase={null}
          onHome={vi.fn()}
          onSelect={vi.fn()}
          onSettings={vi.fn()}
          onStatusChanged={vi.fn()}
        />
      </AmbientAnchorContext.Provider>
    )
    act(() => viewTitleStore.publish({ label: 'General', blurb: 'Appearance.' }))
    setLight.mockClear()
    setCutoff.mockClear()
    act(() => viewTitleStore.publish(null))
    expect(released).toEqual(expect.arrayContaining(['cutoff', 'light']))
    // and never by re-calling the ref itself, which is what would silently clobber whichever view
    // has since claimed the slot
    expect(setCutoff).not.toHaveBeenCalled()
    expect(setLight).not.toHaveBeenCalled()
  })

  // Task 6: the Settings button is the global backstop for held-back items — the reader who
  // needs to know is not necessarily on the Settings page when a survey holds something back, so
  // the count has to reach them here. Mirrors the Proposals pill's badge idiom (above).
  it('badges the Settings button with the held-back count', async () => {
    const currency: CurrencyPayload = {
      auto: true,
      lastSurveyAt: new Date().toISOString(),
      blocked: [
        {
          domain: 'hive-skill',
          key: 'skill/a',
          label: 'a',
          from: 'x',
          to: 'y',
          verdict: 'blocked',
          reason: { kind: 'local-edits' }
        }
      ],
      busy: false
    }
    window.argus.currency.get = vi.fn(async () => currency)
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(await screen.findByLabelText('Settings — 1 update needs you')).toBeInTheDocument()
  })

  // Regression pin: the noun-only ternary (`update${n === 1 ? '' : 's'} needs you`) shipped
  // wrong on the Packs page and was fixed twice on this branch — a single-item test cannot catch
  // it, since "1 update needs you" reads fine either way. Two items is what exposes a verb that
  // was never pluralized.
  it('agrees the verb with the noun in the Settings badge at n=2', async () => {
    const currency: CurrencyPayload = {
      auto: true,
      lastSurveyAt: new Date().toISOString(),
      blocked: [
        {
          domain: 'hive-skill',
          key: 'skill/a',
          label: 'a',
          from: 'x',
          to: 'y',
          verdict: 'blocked',
          reason: { kind: 'local-edits' }
        },
        {
          domain: 'pack',
          key: 'cg',
          label: 'CG',
          from: '1',
          to: '2',
          verdict: 'blocked',
          reason: { kind: 'new-dependency' }
        }
      ],
      busy: false
    }
    window.argus.currency.get = vi.fn(async () => currency)
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(await screen.findByLabelText('Settings — 2 updates need you')).toBeInTheDocument()
  })

  // Negative counterpart: with nothing held back the button must go back to its plain,
  // unbadged name — a stale "needs you" would be a lie. Falsifiable because the button's
  // accessible name is `undefined`-free ('Settings' or 'Settings — N ...'): if the badge code
  // wrongly fired at n === 0, this would look for `Settings — 0 updates need you` instead and
  // fail to find a plain 'Settings' label.
  it('leaves the Settings button unbadged when nothing is held back', async () => {
    render(
      <TopBar
        activeSlug={null}
        activeCase={null}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    expect(await screen.findByLabelText('Settings')).toBeInTheDocument()
  })

  // Task 7: the first-run notice. `HeaderNotice` (mounted here, inside the case group) is its
  // only host — a notice pushed with no case open is silently dropped — so this is where the
  // listener that turns `currency:adopted` into a notice, and then acknowledges it, has to live.
  describe('first-run mirror notice', () => {
    it('shows the notice and acknowledges it only AFTER it is on screen', async () => {
      uiStore.openTab('NAV-1')
      let fire: ((n: number) => void) | null = null
      window.argus.currency.onAdopted = vi.fn((cb: (n: number) => void) => {
        fire = cb
        return () => {}
      })
      // Order captured through a synchronous side channel, not by asserting inside `ack` itself:
      // `ack` is invoked with `void`, so a `toEqual`/`expect` thrown from inside its body would
      // become an unhandled promise rejection instead of failing this test — that shape was
      // caught live (see task-7-report.md) when a deliberately wrong call order still passed.
      const order: string[] = []
      const originalPush = noticeStore.push.bind(noticeStore)
      const pushSpy = vi.spyOn(noticeStore, 'push').mockImplementation((message, tone) => {
        order.push('push')
        return originalPush(message, tone)
      })
      const ack = vi.fn(() => {
        order.push('ack')
        return Promise.resolve()
      })
      window.argus.currency.ackAdopted = ack

      render(
        <TopBar
          activeSlug="NAV-1"
          activeCase={CASE}
          onHome={vi.fn()}
          onSelect={vi.fn()}
          onSettings={vi.fn()}
          onStatusChanged={vi.fn()}
        />
      )
      await vi.waitFor(() => expect(fire).toBeTruthy())
      act(() => fire!(3))

      expect(
        await screen.findByText(
          "Argus now keeps itself up to date — it installed 3 HiveMind items from your team's repo. You can turn this off in Settings → Updates."
        )
      ).toBeInTheDocument()
      expect(ack).toHaveBeenCalledTimes(1)
      // The actual order proof: the notice was queued (`push`) strictly before main was told it
      // could set the "already shown" flag (`ack`).
      expect(order).toEqual(['push', 'ack'])
      pushSpy.mockRestore()
    })

    it('keeps "item" singular when exactly one was adopted', async () => {
      uiStore.openTab('NAV-1')
      let fire: ((n: number) => void) | null = null
      window.argus.currency.onAdopted = vi.fn((cb: (n: number) => void) => {
        fire = cb
        return () => {}
      })
      render(
        <TopBar
          activeSlug="NAV-1"
          activeCase={CASE}
          onHome={vi.fn()}
          onSelect={vi.fn()}
          onSettings={vi.fn()}
          onStatusChanged={vi.fn()}
        />
      )
      await vi.waitFor(() => expect(fire).toBeTruthy())
      act(() => fire!(1))
      expect(
        await screen.findByText(
          "Argus now keeps itself up to date — it installed 1 HiveMind item from your team's repo. You can turn this off in Settings → Updates."
        )
      ).toBeInTheDocument()
    })

    it('unsubscribes the listener on unmount', () => {
      const off = vi.fn()
      window.argus.currency.onAdopted = vi.fn(() => off)
      const { unmount } = render(
        <TopBar
          activeSlug="NAV-1"
          activeCase={CASE}
          onHome={vi.fn()}
          onSelect={vi.fn()}
          onSettings={vi.fn()}
          onStatusChanged={vi.fn()}
        />
      )
      expect(off).not.toHaveBeenCalled()
      unmount()
      expect(off).toHaveBeenCalledTimes(1)
    })
  })
})
