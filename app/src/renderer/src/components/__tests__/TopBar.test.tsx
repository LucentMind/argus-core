// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TopBar } from '../TopBar'
import { uiStore } from '../../lib/uiStore'
import { caseBarStore } from '../../lib/caseBarStore'
import type { CaseRecord } from '../../../../shared/types'
import type { DistillJobRow } from '../../../../shared/distill'

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
  uiStore.setDynamicTheme(false)
  window.argus = {
    modes: { available: vi.fn(async () => ['investigation', 'review']) },
    distill: { status: vi.fn(async () => null), onChanged: vi.fn(() => () => {}) },
    cases: {
      setStatus: vi.fn(async () => undefined),
      setMode: vi.fn(async () => ({ sessionId: 9 }))
    },
    bundle: { export: vi.fn(async () => ({ ok: true, fileCount: 1 })) },
    jira: { refreshCase: vi.fn(), openIssue: vi.fn() }
  } as never
})

describe('TopBar', () => {
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

  it('closes a non-active tab from the strip', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    const onHome = vi.fn()
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={onHome}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close NAV-2' }))
    expect(onHome).not.toHaveBeenCalled()
    expect(uiStore.get().recentTabs).toEqual(['NAV-1'])
  })

  it('toggles theme from the bar; tool-call visibility lives in the composer only', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(uiStore.get().theme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    // label flips with state
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy()
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

  it('hides each close button until hover or keyboard focus', () => {
    uiStore.openTab('alpha')
    uiStore.openTab('beta')
    // No active case: both tabs stay in the strip, so this can exercise a strip tab's own
    // close button (the active case would be in the anchor instead, which has no ×).
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
    const close = screen.getByRole('button', { name: 'Close alpha' })
    expect(close.className).toContain('opacity-0')
    expect(close.className).toContain('group-hover:opacity-100')
    // without this the button is unreachable by keyboard
    expect(close.className).toContain('focus-visible:opacity-100')
  })

  it('draws a separator between tabs but not before the first', () => {
    uiStore.openTab('alpha')
    uiStore.openTab('beta')
    // No active case: both tabs stay in the strip so there is a separator to find between them.
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
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    expect(nav.querySelectorAll('[data-tab-separator]')).toHaveLength(1)
  })

  it('is a drag region, with every interactive element opted out', async () => {
    uiStore.openTab('NAV-1')
    // A second, non-active tab so the strip actually renders tab buttons — the active case is
    // filtered out of the strip (it lives in the anchor instead).
    uiStore.openTab('NAV-2')
    render(
      <TopBar
        activeSlug="NAV-1"
        activeCase={CASE}
        onHome={vi.fn()}
        onSelect={vi.fn()}
        onSettings={vi.fn()}
        onObservability={vi.fn()}
        onStatusChanged={vi.fn()}
      />
    )
    const header = screen.getByRole('banner')
    expect(header.classList.contains('argus-drag')).toBe(true)
    // The window-buttons inset moved to TitleBarStrip — TopBar no longer sits beside the OS
    // buttons, so it no longer needs to reserve room for them.
    expect(header.classList.contains('argus-titlebar-inset')).toBe(false)

    // ModeSwitcher renders a plain <span> until window.argus.modes.available resolves; wait
    // for the real buttons so they are part of what this test checks, not silently absent.
    await screen.findByRole('button', { name: 'Case mode · Review' })

    // A drag region swallows clicks AND scroll, so everything the user operates has to opt out.
    const interactive = header.querySelectorAll('button, a, input, select, textarea, [tabindex]')
    expect(interactive.length).toBeGreaterThan(8)
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

  it('the strip is the only elastic element and scrolls', () => {
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

  it('reads busy state back off the store', async () => {
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
    const review = await screen.findByRole('button', { name: 'Case mode · Review' })
    expect(review.getAttribute('title')).toBeNull()
    caseBarStore.publish({
      slug: 'NAV-1',
      busyMode: 'review',
      statusText: 'Searching for pull requests…'
    })
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Case mode · Review' }).getAttribute('title')).toBe(
        'Searching for pull requests…'
      )
    )
  })

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
      finishedAt: null
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
    expect(screen.queryByText('distilling…')).toBeNull()
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

  it('ignores busy state published for a different case', async () => {
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
    await screen.findByRole('button', { name: 'Case mode · Review' })
    caseBarStore.publish({ slug: 'OTHER-9', busyMode: 'review', statusText: 'stale' })
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Case mode · Review' }).getAttribute('title')
      ).toBeNull()
    )
  })
})
