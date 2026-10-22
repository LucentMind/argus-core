// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecentTabs } from '../RecentTabs'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  for (const t of [...uiStore.get().recentTabs]) uiStore.closeTab(t)
})

describe('RecentTabs', () => {
  it('renders a tab per recent case and selects on click', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    const onSelect = vi.fn()
    render(<RecentTabs activeSlug="NAV-1" onSelect={onSelect} />)
    fireEvent.click(screen.getByText('NAV-2'))
    expect(onSelect).toHaveBeenCalledWith('NAV-2')
  })

  it('closes a tab without navigating', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    const onSelect = vi.fn()
    render(<RecentTabs activeSlug="NAV-1" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close NAV-2' }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(uiStore.get().recentTabs).toEqual(['NAV-1'])
  })

  it('keeps the active case out of the band — it lives in the bar’s case anchor', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    render(<RecentTabs activeSlug="NAV-1" onSelect={vi.fn()} />)
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    expect(nav.textContent).not.toContain('NAV-1')
    expect(nav.textContent).toContain('NAV-2')
  })

  it('hides each close button until hover or keyboard focus', () => {
    uiStore.openTab('alpha')
    uiStore.openTab('beta')
    render(<RecentTabs activeSlug={null} onSelect={vi.fn()} />)
    const close = screen.getByRole('button', { name: 'Close alpha' })
    expect(close.className).toContain('opacity-0')
    expect(close.className).toContain('group-hover:opacity-100')
    // without this the button is unreachable by keyboard
    expect(close.className).toContain('focus-visible:opacity-100')
  })

  it('draws a separator between tabs but not before the first', () => {
    uiStore.openTab('alpha')
    uiStore.openTab('beta')
    render(<RecentTabs activeSlug={null} onSelect={vi.fn()} />)
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    expect(nav.querySelectorAll('[data-tab-separator]')).toHaveLength(1)
  })

  // What this component owes its parent: it is as wide as its tabs and no wider (`min-w-0` lets it
  // give width back and scroll rather than grow), right-aligned by its OWN auto margin, and it
  // places no percentage margin — an `ml-[50%]` here is the exact bug that pushed the bar's action
  // icons out of the window, since a percentage margin cannot flex. Bounding is TopBar's job.
  //
  // It must NOT claim the leftover space (`flex-1`): the band is one `argus-nodrag` box, so every
  // pixel it takes is a pixel of title bar that cannot drag the window. With one small tab the old
  // `flex-1` band blocked ~460px of empty bar (measured over WM_NCHITTEST, 2026-10-22).
  //
  // The right-alignment of the tabs within an overflowing band is an auto margin on the inner row;
  // `justify-end` on the scroller instead would spill the overflow past the container's start edge,
  // where no amount of scrolling reaches it. jsdom lays nothing out, so this is the only level at
  // which any of it is assertable.
  it('is as wide as its tabs, yields width back, and never claims the leftover space', () => {
    uiStore.openTab('alpha')
    render(<RecentTabs activeSlug={null} onSelect={vi.fn()} />)
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    const cls = nav.className.split(/\s+/)
    expect(cls).not.toContain('flex-1')
    expect(cls).not.toContain('grow')
    expect(cls).toContain('ml-auto')
    expect(cls).toContain('min-w-0')
    expect(cls).toContain('overflow-x-auto')
    expect(nav.className).not.toMatch(/\bml-\[/)
    expect(nav.className).not.toContain('justify-end')
    const row = nav.firstElementChild
    expect(row?.className).toContain('ml-auto')
    expect(row?.className).toContain('shrink-0')
  })

  // The OS drag handler swallows clicks AND wheel events over a drag region, and the bar this
  // band sits in is one — so without opting out the tabs are neither clickable nor scrollable.
  it('opts the whole band out of the bar’s drag region', () => {
    uiStore.openTab('alpha')
    render(<RecentTabs activeSlug={null} onSelect={vi.fn()} />)
    const nav = screen.getByRole('navigation', { name: 'Recent cases' })
    expect(nav.classList.contains('argus-nodrag')).toBe(true)
    // `-webkit-app-region` is not inherited and Chromium builds the no-drag rect from the
    // element's own border box, so a band shorter than the bar would leave a draggable sliver
    // over the tabs. Verified live, not here — jsdom implements no app-region.
    expect(nav.className).toContain('h-full')
    for (const el of nav.querySelectorAll('button')) {
      expect(el.closest('.argus-nodrag')).not.toBeNull()
    }
  })
})
