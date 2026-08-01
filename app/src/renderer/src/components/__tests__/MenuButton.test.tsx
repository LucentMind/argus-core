// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MenuButton, type MenuItem } from '../ui'

const items = (onA = vi.fn(), onB = vi.fn()): MenuItem[] => [
  { label: 'Action A', onSelect: onA },
  { label: 'Danger B', onSelect: onB, tone: 'danger' as const },
  { label: 'Disabled C', onSelect: vi.fn(), disabled: true }
]

describe('MenuButton', () => {
  it('opens on click, selects an item (fires + closes)', () => {
    const onA = vi.fn()
    render(<MenuButton label="Edit" aria-label="actions" items={items(onA)} />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Action A' }))
    expect(onA).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Escape and outside-click close without selecting', () => {
    const onA = vi.fn()
    render(
      <div>
        <button>outside</button>
        <MenuButton label="Edit" aria-label="actions" items={items(onA)} />
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    fireEvent.mouseDown(screen.getByText('outside'))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onA).not.toHaveBeenCalled()
  })

  it('reports open/close through onOpenChange (for occlusion wiring)', () => {
    const onOpenChange = vi.fn()
    render(
      <MenuButton label="Edit" aria-label="actions" items={items()} onOpenChange={onOpenChange} />
    )
    onOpenChange.mockClear() // ignore the initial mount notification
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('disabled items are inert', () => {
    render(<MenuButton label="Edit" aria-label="actions" items={items()} />)
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    const c = screen.getByRole('menuitem', { name: 'Disabled C' }) as HTMLButtonElement
    expect(c.disabled).toBe(true)
    fireEvent.click(c)
    expect(screen.getByRole('menu')).toBeTruthy() // still open, nothing fired
  })

  it('the dropdown carries both the flat classes and the frosted material', () => {
    // Same split as ModalShell's dialog: `glass-card` supplies the frosted look, but
    // theme-dynamic.css gates it to light for `role="menu"` (see the "overlay opt-out" tests in
    // themeTokens.test.ts), so the flat utility classes must stay too — they're what actually
    // renders in dark, and what its `revert-layer` falls back to. jsdom resolves no cascade, so
    // this only proves the class *contract*, not which theme wins; the real-browser,
    // computed-style proof lives in the Task 8 follow-up report.
    render(<MenuButton label="Edit" aria-label="actions" items={items()} />)
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    const cls = screen.getByRole('menu').className
    expect(cls).toContain('glass-card')
    expect(cls).toContain('border-hair')
    expect(cls).toContain('shadow-lg')
  })
})
