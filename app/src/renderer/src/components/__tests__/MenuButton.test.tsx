// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('the dropdown carries the overlay material, not glass-card', () => {
    // Task 8 rework: `.overlay-menu` (main.css) owns the whole look itself — flat in dark,
    // frosted in light — replacing a `glass-card` + flat-utilities + `revert-layer` combination.
    // jsdom resolves no cascade, so this only proves the class *contract*, not which theme wins
    // or what the computed styles are; the real-browser, computed-style proof lives in the
    // Task 8 follow-up report.
    render(<MenuButton label="Edit" aria-label="actions" items={items()} />)
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    const cls = screen.getByRole('menu').className
    expect(cls).toContain('overlay-menu')
    expect(cls).not.toContain('glass-card')
  })

  it('the dropdown still anchors with `absolute` (Task 8 layout regression pin)', () => {
    // The bug this rework fixes: `.glass-card` sets `position: relative; overflow: hidden`,
    // unlayered, so it beat the dropdown's own `absolute` (a Tailwind utility, `@layer
    // utilities`) — the dropdown rendered in normal flow instead of anchored to its trigger, and
    // `overflow: hidden` would have clipped the `left-full` submenu. jsdom cannot evaluate the
    // cascade or tell us which `position`/`overflow` wins, so this only pins the source-level
    // precondition for staying fixed: the dropdown must keep requesting `absolute` in its class
    // list, and `.overlay-menu` (and `.overlay-card`, the same class of surface) must never
    // reintroduce a `position` or `overflow` declaration that could out-cascade it. The
    // real-browser proof that `absolute` actually wins the cascade is in the Task 8 report.
    render(<MenuButton label="Edit" aria-label="actions" items={items()} />)
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    const cls = screen.getByRole('menu').className
    expect(cls.split(/\s+/)).toContain('absolute')

    const mainCss = readFileSync(join(__dirname, '../../assets/main.css'), 'utf8')
    for (const selector of ['.overlay-card', '.overlay-menu']) {
      const start = mainCss.indexOf(`${selector} {`)
      expect(start, `${selector} rule must be found`).toBeGreaterThanOrEqual(0)
      const open = mainCss.indexOf('{', start)
      const close = mainCss.indexOf('}', open)
      expect(close, `${selector} rule must close`).toBeGreaterThan(open)
      const body = mainCss.slice(open + 1, close)
      expect(body, `${selector} must not declare position`).not.toMatch(/(?<![\w-])position\s*:/)
      expect(body, `${selector} must not declare overflow`).not.toMatch(/(?<![\w-])overflow\s*:/)
    }
  })
})
