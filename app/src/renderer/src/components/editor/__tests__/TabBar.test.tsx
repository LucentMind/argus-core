// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TabBar } from '../TabBar'
import type { Tab } from '../tabs'

const tab = (over: Partial<Tab> & Pick<Tab, 'id' | 'name'>): Tab => ({
  kind: 'skill',
  mode: 'edit',
  dirty: false,
  view: null,
  req: { kind: 'skill', name: over.name, mode: 'edit' },
  ...over
})

const TABS: Tab[] = [
  tab({ id: 't1', name: 'alpha' }),
  tab({ id: 't2', name: 'beta', dirty: true }),
  tab({ id: 't3', name: 'notes.md', kind: 'reference' })
]

describe('TabBar', () => {
  it('renders one tab per open asset', () => {
    render(<TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('marks the active tab selected and the others not', () => {
    render(<TabBar tabs={TABS} activeId="t2" onActivate={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('tab', { name: /beta/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /alpha/ })).toHaveAttribute('aria-selected', 'false')
  })

  it('activates a tab when it is clicked', async () => {
    const onActivate = vi.fn()
    render(<TabBar tabs={TABS} activeId="t1" onActivate={onActivate} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('tab', { name: /beta/ }))
    expect(onActivate).toHaveBeenCalledWith('t2')
  })

  // Spec §6.1: "The dot on the tab is information, not a warning." It must be announced, not
  // just coloured — jsdom applies no CSS, and a colour-only signal is unreachable anyway.
  it('announces unsaved changes on a dirty tab', () => {
    render(<TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('tab', { name: /beta/ })).toHaveAccessibleName(/unsaved/i)
    expect(screen.getByRole('tab', { name: /alpha/ })).not.toHaveAccessibleName(/unsaved/i)
  })

  it('closes a tab from its close button', async () => {
    const onClose = vi.fn()
    render(<TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Close alpha' }))
    expect(onClose).toHaveBeenCalledWith('t1')
  })

  // The close button sits inside the tab. Without stopPropagation the same click also activates
  // the tab that is being removed, which flickers the surface and races the close.
  it('does not activate a tab when its close button is clicked', async () => {
    const onActivate = vi.fn()
    render(<TabBar tabs={TABS} activeId="t1" onActivate={onActivate} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Close beta' }))
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('distinguishes a reference from a skill of the same name', () => {
    render(
      <TabBar
        tabs={[
          tab({ id: 'a', name: 'notes.md' }),
          tab({ id: 'b', name: 'notes.md', kind: 'reference' })
        ]}
        activeId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('tab', { name: /^skill · notes\.md/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^reference · notes\.md/ })).toBeInTheDocument()
  })

  // Spec §6.1: overflow scrolls horizontally with a dropdown. The strip itself scrolls; the
  // dropdown is how you reach a tab that has scrolled out of sight.
  it('lists every tab in the overflow dropdown', async () => {
    const onActivate = vi.fn()
    render(<TabBar tabs={TABS} activeId="t1" onActivate={onActivate} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /all tabs/i }))
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual(['alpha', 'beta', 'notes.md'])
    await userEvent.click(items[2])
    expect(onActivate).toHaveBeenCalledWith('t3')
  })

  it('closes the dropdown after a pick', async () => {
    render(<TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /all tabs/i }))
    await userEvent.click(screen.getAllByRole('menuitem')[0])
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  // One tab is the Increment 3 situation, and a strip with a single tab and an overflow chevron
  // is noise.
  it('hides the overflow button when only one tab is open', () => {
    render(<TabBar tabs={[TABS[0]]} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /all tabs/i })).not.toBeInTheDocument()
  })

  it('renders nothing when no tabs are open', () => {
    const { container } = render(
      <TabBar tabs={[]} activeId={null} onActivate={vi.fn()} onClose={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  describe('keyboard', () => {
    it('activates the focused tab on Enter', async () => {
      const onActivate = vi.fn()
      render(<TabBar tabs={TABS} activeId="t1" onActivate={onActivate} onClose={vi.fn()} />)
      screen.getByRole('tab', { name: /alpha/ }).focus()
      await userEvent.keyboard('{Enter}')
      expect(onActivate).toHaveBeenCalledWith('t1')
    })

    it('activates the focused tab on Space', async () => {
      const onActivate = vi.fn()
      render(<TabBar tabs={TABS} activeId="t1" onActivate={onActivate} onClose={vi.fn()} />)
      screen.getByRole('tab', { name: /alpha/ }).focus()
      await userEvent.keyboard(' ')
      expect(onActivate).toHaveBeenCalledWith('t1')
    })

    // Roving tabindex, automatic activation (WAI-ARIA tabs pattern): ArrowRight/ArrowLeft both
    // move focus AND activate the adjacent tab, wrapping at the ends. This is the same model
    // already implied by mouse click-to-activate, and it keeps tabIndex tied to `activeId` alone
    // — no extra "focused but not active" state is needed on top of the one flag (menuOpen) this
    // component is allowed to own.
    it('moves activation to the next tab on ArrowRight, wrapping past the last tab', async () => {
      const onActivate = vi.fn()
      render(<TabBar tabs={TABS} activeId="t1" onActivate={onActivate} onClose={vi.fn()} />)
      screen.getByRole('tab', { name: /alpha/ }).focus()
      await userEvent.keyboard('{ArrowRight}')
      expect(onActivate).toHaveBeenCalledWith('t2')
    })

    it('wraps ArrowRight from the last tab back to the first', async () => {
      const onActivate = vi.fn()
      render(<TabBar tabs={TABS} activeId="t3" onActivate={onActivate} onClose={vi.fn()} />)
      screen.getByRole('tab', { name: /notes\.md/ }).focus()
      await userEvent.keyboard('{ArrowRight}')
      expect(onActivate).toHaveBeenCalledWith('t1')
    })

    it('moves activation to the previous tab on ArrowLeft, wrapping before the first tab', async () => {
      const onActivate = vi.fn()
      render(<TabBar tabs={TABS} activeId="t1" onActivate={onActivate} onClose={vi.fn()} />)
      screen.getByRole('tab', { name: /alpha/ }).focus()
      await userEvent.keyboard('{ArrowLeft}')
      expect(onActivate).toHaveBeenCalledWith('t3')
    })

    it('jumps to the first tab on Home and the last tab on End', async () => {
      const onActivate = vi.fn()
      render(<TabBar tabs={TABS} activeId="t2" onActivate={onActivate} onClose={vi.fn()} />)
      screen.getByRole('tab', { name: /beta/ }).focus()
      await userEvent.keyboard('{Home}')
      expect(onActivate).toHaveBeenCalledWith('t1')
      onActivate.mockClear()
      await userEvent.keyboard('{End}')
      expect(onActivate).toHaveBeenCalledWith('t3')
    })

    // Only the active tab (and its close button) is a tab stop. Before the fix, every close
    // button was reachable via Tab regardless of its own tab's tabIndex, so a keyboard-only user
    // could never reach an inactive tab at all — verified empirically against the unfixed code.
    it('keeps an inactive tab and its close button out of the sequential tab order', () => {
      render(<TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />)
      expect(screen.getByRole('tab', { name: /beta/ })).toHaveAttribute('tabIndex', '-1')
      expect(screen.getByRole('button', { name: 'Close beta' })).toHaveAttribute('tabIndex', '-1')
      expect(screen.getByRole('tab', { name: /alpha/ })).toHaveAttribute('tabIndex', '0')
      expect(screen.getByRole('button', { name: 'Close alpha' })).toHaveAttribute('tabIndex', '0')
    })

    it('closes the overflow menu on Escape', async () => {
      render(<TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /all tabs/i }))
      expect(screen.getAllByRole('menuitem')).toHaveLength(3)
      await userEvent.keyboard('{Escape}')
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    })

    it('closes the overflow menu on an outside click', async () => {
      render(
        <div>
          <button type="button">outside</button>
          <TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />
        </div>
      )
      await userEvent.click(screen.getByRole('button', { name: /all tabs/i }))
      expect(screen.getAllByRole('menuitem')).toHaveLength(3)
      await userEvent.click(screen.getByRole('button', { name: 'outside' }))
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    })

    it('sets aria-haspopup on the overflow trigger', () => {
      render(<TabBar tabs={TABS} activeId="t1" onActivate={vi.fn()} onClose={vi.fn()} />)
      expect(screen.getByRole('button', { name: /all tabs/i })).toHaveAttribute(
        'aria-haspopup',
        'menu'
      )
    })
  })
})
