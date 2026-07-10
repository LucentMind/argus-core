// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SettingsSection, SettingRow, Switch } from '../settings/settingsLayout'
import { AnnotatedForm } from '../settings/AnnotatedForm'
import { DRIVERS } from '../../../../shared/drivers'

describe('SettingRow', () => {
  it('shows reset only when non-default, and fires it', () => {
    const onReset = vi.fn()
    const { rerender } = render(
      <SettingRow label="Max sessions" isDefault onReset={onReset}>
        <span>3</span>
      </SettingRow>
    )
    expect(screen.queryByRole('button', { name: 'Reset Max sessions' })).toBeNull()
    rerender(
      <SettingRow label="Max sessions" isDefault={false} onReset={onReset}>
        <span>5</span>
      </SettingRow>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset Max sessions' }))
    expect(onReset).toHaveBeenCalled()
  })
})

describe('Switch', () => {
  it('is a role=switch reflecting and toggling state', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} aria-label="Confirm case delete" />)
    const sw = screen.getByRole('switch', { name: 'Confirm case delete' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('AnnotatedForm', () => {
  it('renders driver fields in order and reports edits + clears', () => {
    const onChange = vi.fn()
    render(
      <SettingsSection title="Provider">
        <AnnotatedForm
          annotations={DRIVERS['claude-agent-sdk'].formAnnotations}
          value={{ model: 'claude-sonnet-5' }}
          onChange={onChange}
        />
      </SettingsSection>
    )
    const model = screen.getByLabelText('Model') as HTMLInputElement
    expect(model.value).toBe('claude-sonnet-5')
    fireEvent.change(model, { target: { value: 'claude-opus-4-8' } })
    expect(onChange).toHaveBeenCalledWith('model', 'claude-opus-4-8')
    fireEvent.change(model, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith('model', null)
    expect(screen.getByLabelText('Claude CLI path')).toBeTruthy()
  })
})
