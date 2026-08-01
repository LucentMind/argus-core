// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RowActions, RowToggle, SettingRow, SettingsSection } from '../settingsLayout'

describe('SettingRow onOpen', () => {
  it('renders the label as an open button when onOpen is set', () => {
    const onOpen = vi.fn()
    render(
      <SettingRow label="rca" description={<span>meta line</span>} onOpen={onOpen}>
        <span>controls</span>
      </SettingRow>
    )
    fireEvent.click(screen.getByRole('button', { name: 'open · rca' }))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.getByText('meta line')).toBeInTheDocument()
  })

  it('keeps a plain span label without onOpen', () => {
    render(
      <SettingRow label="plain">
        <span>controls</span>
      </SettingRow>
    )
    expect(screen.queryByRole('button', { name: 'open · plain' })).toBeNull()
    expect(screen.getByText('plain')).toBeInTheDocument()
  })
})

describe('SettingsSection collapse', () => {
  it('toggle button hides children and flips aria-expanded', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <SettingsSection title="HiveMind" count={2} collapsed={false} onToggle={onToggle}>
        <span>row content</span>
      </SettingsSection>
    )
    const btn = screen.getByRole('button', { name: 'Toggle section · HiveMind' })
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('row content')).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledOnce()
    rerender(
      <SettingsSection title="HiveMind" count={2} collapsed onToggle={onToggle}>
        <span>row content</span>
      </SettingsSection>
    )
    expect(screen.queryByText('row content')).toBeNull()
    expect(btn).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders a subtitle below the header when given one', () => {
    render(
      <SettingsSection title="Yours" subtitle="You own these." collapsed={false} onToggle={vi.fn()}>
        <div>child</div>
      </SettingsSection>
    )
    expect(screen.getByText('You own these.')).toBeInTheDocument()
  })

  it('renders no subtitle element when the prop is omitted', () => {
    const { container } = render(
      <SettingsSection title="Yours" collapsed={false} onToggle={vi.fn()}>
        <div>child</div>
      </SettingsSection>
    )
    expect(container.querySelector('p.text-xs')).toBeNull()
  })

  it('keeps the subtitle visible while the section is collapsed', () => {
    render(
      <SettingsSection title="Yours" subtitle="You own these." collapsed onToggle={vi.fn()}>
        <div>child</div>
      </SettingsSection>
    )
    expect(screen.getByText('You own these.')).toBeInTheDocument()
    expect(screen.queryByText('child')).toBeNull()
  })
})

/**
 * jsdom loads no stylesheet and resolves no cascade, so these assert the CLASS the row carries,
 * not its computed effect — the same contract-on-the-source idiom `CaseFiles.test.tsx` uses for
 * its own `line-clamp-2`. Each one pins a specific defect the classes were chosen to fix.
 */
describe('row hover affordances', () => {
  it('reveals actions on hover and on keyboard focus, but not on a mouse click', () => {
    const { container } = render(
      <RowActions>
        <button>Delete</button>
      </RowActions>
    )
    const col = container.firstElementChild as HTMLElement
    expect(col.className).toContain('group-hover/row:opacity-100')
    // The fix for "the appeared button does not disappear anymore": a mouse click leaves focus
    // inside the row, so a focus-WITHIN reveal latches on and never releases. :focus-visible is
    // not set by a mouse click, so it reveals for Tab and stays out of the way for the pointer.
    expect(col.className).toContain('group-has-[:focus-visible]/row:opacity-100')
    expect(col.className).not.toContain('group-focus-within')
  })

  it('reserves the action column at rest, so hovering a row cannot reflow it', () => {
    const { container } = render(
      <RowActions>
        <button>Delete</button>
      </RowActions>
    )
    const col = container.firstElementChild as HTMLElement
    // Opacity only. A width/margin transition (what `Reveal` used to do) is exactly what pushed
    // the description into an extra line and grew the row's height under the cursor.
    expect(col.className).toContain('opacity-0')
    expect(col.className).not.toMatch(/\bw-0\b/)
    expect(col.className).not.toContain('group-hover/row:w-auto')
  })

  it('gives a row with no toggle the same slot as one with a toggle', () => {
    const withToggle = render(
      <RowToggle>
        <button role="switch" aria-checked="false" aria-label="on" />
      </RowToggle>
    )
    const empty = render(<RowToggle />)
    const a = withToggle.container.firstElementChild as HTMLElement
    const b = empty.container.firstElementChild as HTMLElement
    expect(a.className).toBe(b.className)
    expect(b.className).toContain('w-9')
  })
})

describe('SettingRow description', () => {
  it('caps the description at two lines', () => {
    render(
      <SettingRow label="skill" description="a very long description">
        <span>controls</span>
      </SettingRow>
    )
    expect(screen.getByText('a very long description').className).toContain('line-clamp-2')
  })
})
