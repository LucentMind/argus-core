// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { SettingRow, SettingsSection } from '../settingsLayout'

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
})
