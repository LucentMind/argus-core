// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, fireEvent } from '@testing-library/react'
import { MenuButton, type MenuItem } from '../ui'
import { overlayMaterialRules } from '../../assets/__tests__/cssRuleScan'

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
    // Why .overlay-menu exists rather than `.glass-card`: see main.css's comment above
    // `.overlay-card`. jsdom resolves no cascade, so this only proves the class *contract*; the
    // real-browser, computed-style proof lives in the Task 8 follow-up report.
    render(<MenuButton label="Edit" aria-label="actions" items={items()} />)
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    const cls = screen.getByRole('menu').className
    expect(cls).toContain('overlay-menu')
    expect(cls).not.toContain('glass-card')
  })

  it('the dropdown still anchors with `absolute` (Task 8 layout regression pin)', () => {
    // jsdom cannot evaluate the cascade, so this only pins the source-level precondition for
    // staying fixed: the dropdown must keep requesting `absolute` in its class list, and neither
    // overlay rule (base or light override) may reintroduce a `position`/`overflow` declaration
    // that could out-cascade it — see main.css's comment above `.overlay-card` for the defect
    // this replaced. The real-browser proof that `absolute` actually wins the cascade is in the
    // Task 8 report.
    render(<MenuButton label="Edit" aria-label="actions" items={items()} />)
    fireEvent.click(screen.getByRole('button', { name: 'actions' }))
    const cls = screen.getByRole('menu').className
    expect(cls.split(/\s+/)).toContain('absolute')

    const mainCss = readFileSync(join(__dirname, '../../assets/main.css'), 'utf8')
    const rules = overlayMaterialRules(mainCss)
    expect(
      rules.length,
      'expected the dark base rules plus the light override'
    ).toBeGreaterThanOrEqual(3)
    for (const { selector, body } of rules) {
      expect(body, `${selector} must not declare position`).not.toMatch(/(?<![\w-])position\s*:/)
      expect(body, `${selector} must not declare overflow`).not.toMatch(/(?<![\w-])overflow\s*:/)
    }
  })
})
