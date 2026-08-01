// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TopBar } from '../TopBar'
import { uiStore } from '../../lib/uiStore'
import { caseBarStore } from '../../lib/caseBarStore'
import type { CaseRecord } from '../../../../shared/types'

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

  it('is a drag region, with every interactive element opted out', () => {
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
    // The window-buttons inset moved to TitleBarStrip — TopBar no longer sits beside the OS
    // buttons, so it no longer needs to reserve room for them.
    expect(header.classList.contains('argus-titlebar-inset')).toBe(false)

    // A drag region swallows clicks AND scroll, so everything the user operates has to opt out.
    const interactive = header.querySelectorAll('button, a, input, select, textarea, [tabindex]')
    expect(interactive.length).toBeGreaterThan(4)
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
