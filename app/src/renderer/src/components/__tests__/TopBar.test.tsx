// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TopBar } from '../TopBar'
import { uiStore } from '../../lib/uiStore'
import { caseBarStore } from '../../lib/caseBarStore'
import { settingsBarStore } from '../../lib/settingsBarStore'
import { AmbientAnchorContext } from '../../lib/ambientAnchors'
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
  settingsBarStore.reset()
  uiStore.setDynamicTheme(false)
  window.argus = {
    modes: { available: vi.fn(async () => ['investigation', 'review']) },
    distill: { status: vi.fn(async () => null), onChanged: vi.fn(() => () => {}) },
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

  it('is a drag region, with every interactive element opted out', async () => {
    uiStore.openTab('NAV-1')
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
        onObservability={vi.fn()}
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

    // the icons live in that same group, after the band, and never give up width
    for (const name of ['Observability', 'Settings', 'Switch to light theme']) {
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
    expect(screen.queryByTestId('settings-title')).not.toBeInTheDocument()
    act(() => settingsBarStore.publish({ label: 'General', blurb: 'Appearance and shell.' }))
    const title = screen.getByTestId('settings-title')
    const blurb = screen.getByTestId('settings-blurb')
    expect(title).toHaveTextContent('General')
    expect(blurb).toHaveTextContent('Appearance and shell.')
    // Single line, always, with the full text reachable on hover: a masthead that grows by a
    // line on navigation would change the header's height as the user browses (former
    // SettingsView masthead test, ported here since the identity now renders in TopBar).
    expect(title.className).toContain('truncate')
    expect(blurb.className).toContain('truncate')
    expect(blurb.getAttribute('title')).toBe(blurb.textContent)
    act(() => settingsBarStore.publish(null))
    expect(screen.queryByTestId('settings-title')).not.toBeInTheDocument()
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
    act(() => settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' }))
    expect(setCutoff).toHaveBeenCalledWith(screen.getByRole('banner'))
    expect(setLight).toHaveBeenCalledWith(screen.getByTestId('settings-title'))
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
    act(() => settingsBarStore.publish({ label: 'General', blurb: 'Appearance.' }))
    setLight.mockClear()
    setCutoff.mockClear()
    act(() => settingsBarStore.publish(null))
    expect(released).toEqual(expect.arrayContaining(['cutoff', 'light']))
    // and never by re-calling the ref itself, which is what would silently clobber whichever view
    // has since claimed the slot
    expect(setCutoff).not.toHaveBeenCalled()
    expect(setLight).not.toHaveBeenCalled()
  })
})
