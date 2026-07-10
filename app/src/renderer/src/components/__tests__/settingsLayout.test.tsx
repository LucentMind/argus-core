// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SettingsSection, SettingRow, Switch, DraftInput } from '../settings/settingsLayout'
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
          value={{ cliPath: '/usr/bin/claude' }}
          onChange={onChange}
        />
      </SettingsSection>
    )
    // model is intentionally absent from formAnnotations — it's rendered by the Models section
    const cliPath = screen.getByLabelText('Claude CLI path') as HTMLInputElement
    expect(cliPath.value).toBe('/usr/bin/claude')
    fireEvent.change(cliPath, { target: { value: '/opt/claude' } })
    fireEvent.blur(cliPath)
    expect(onChange).toHaveBeenCalledWith('cliPath', '/opt/claude')
    fireEvent.change(cliPath, { target: { value: '' } })
    fireEvent.blur(cliPath)
    expect(onChange).toHaveBeenCalledWith('cliPath', null)
  })
})

describe('DraftInput', () => {
  it('does not commit while typing; blur commits once with the latest draft', () => {
    const onCommit = vi.fn()
    render(<DraftInput value="a" onCommit={onCommit} aria-label="Draft field" />)
    const input = screen.getByLabelText('Draft field') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ab' } })
    fireEvent.change(input, { target: { value: 'abc' } })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('abc')
  })
})
