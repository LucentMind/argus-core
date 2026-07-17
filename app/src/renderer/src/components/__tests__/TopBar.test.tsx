// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TopBar } from '../TopBar'
import { uiStore } from '../../lib/uiStore'

beforeEach(() => {
  localStorage.clear()
  for (const t of [...uiStore.get().recentTabs]) uiStore.closeTab(t)
  if (uiStore.get().theme !== 'dark') uiStore.setTheme('dark')
  if (!uiStore.get().showToolCalls) uiStore.setShowToolCalls(true)
})

describe('TopBar', () => {
  it('renders recent-case tabs and selects on click', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    const onSelect = vi.fn()
    render(<TopBar activeSlug="NAV-1" onHome={vi.fn()} onSelect={onSelect} onSettings={vi.fn()} />)
    fireEvent.click(screen.getByText('NAV-2'))
    expect(onSelect).toHaveBeenCalledWith('NAV-2')
  })

  it('closing the active tab navigates home; closing another does not', () => {
    uiStore.openTab('NAV-1')
    uiStore.openTab('NAV-2')
    const onHome = vi.fn()
    render(<TopBar activeSlug="NAV-1" onHome={onHome} onSelect={vi.fn()} onSettings={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close NAV-2' }))
    expect(onHome).not.toHaveBeenCalled()
    expect(uiStore.get().recentTabs).toEqual(['NAV-1'])
    fireEvent.click(screen.getByRole('button', { name: 'Close NAV-1' }))
    expect(onHome).toHaveBeenCalled()
    expect(uiStore.get().recentTabs).toEqual([])
  })

  it('toggles theme from the bar; tool-call visibility lives in the composer only', () => {
    render(<TopBar activeSlug={null} onHome={vi.fn()} onSelect={vi.fn()} onSettings={vi.fn()} />)
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
    render(<TopBar activeSlug={null} onHome={onHome} onSelect={vi.fn()} onSettings={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'All cases' }))
    expect(onHome).toHaveBeenCalled()
  })

  it('gear button fires onSettings', () => {
    const onSettings = vi.fn()
    render(<TopBar activeSlug={null} onHome={vi.fn()} onSelect={vi.fn()} onSettings={onSettings} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSettings).toHaveBeenCalled()
  })
})
