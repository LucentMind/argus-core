// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import {
  SettingsSection,
  SettingRow,
  Switch,
  DraftInput,
  DraftTextarea
} from '../settings/settingsLayout'
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

describe('SettingRow hint', () => {
  it('renders a title attribute on the label when hint is set', () => {
    render(
      <SettingRow label="Atlassian API token (PAT)" hint="Used for REST attachments">
        <span>child</span>
      </SettingRow>
    )
    const label = screen.getByText('Atlassian API token (PAT)')
    expect(label.getAttribute('title')).toBe('Used for REST attachments')
  })

  it('no title attribute when hint is absent', () => {
    render(
      <SettingRow label="Max sessions">
        <span>3</span>
      </SettingRow>
    )
    expect(screen.getByText('Max sessions').getAttribute('title')).toBeNull()
  })
})

describe('SettingRow stacked variant', () => {
  it('stacked: label/reset share line 1, description is its own full-width line, children wrap on line 3', () => {
    const onReset = vi.fn()
    render(
      <SettingRow
        label="Trace tools directory"
        description="Directory containing sample-trace"
        isDefault={false}
        onReset={onReset}
        stacked
      >
        <span>child-a</span>
        <span>child-b</span>
      </SettingRow>
    )
    const label = screen.getByText('Trace tools directory')
    const description = screen.getByText('Directory containing sample-trace')
    const childA = screen.getByText('child-a')

    // description is not in the same row div as the label/reset line
    expect(label.closest('div')).not.toBe(description.parentElement)
    // children live in their own full-width, wrapping row
    const childrenRow = childA.parentElement
    expect(childrenRow?.className).toContain('flex-wrap')
    expect(childrenRow?.className).toContain('pt-2')
    expect(childrenRow).not.toBe(description.parentElement)

    fireEvent.click(screen.getByRole('button', { name: 'Reset Trace tools directory' }))
    expect(onReset).toHaveBeenCalled()
  })

  it('stacked: trailing renders on line 1 alongside the label, not in the children row', () => {
    render(
      <SettingRow label="sample-parse binary" stacked trailing={<span>found</span>}>
        <span>child-a</span>
      </SettingRow>
    )
    const label = screen.getByText('sample-parse binary')
    const trailing = screen.getByText('found')
    const childA = screen.getByText('child-a')

    // trailing sits in the same line-1 row div as the label, not with the children
    expect(trailing.closest('div')).toBe(label.closest('div'))
    expect(trailing.closest('div')).not.toBe(childA.parentElement)
  })

  it('non-stacked row keeps its existing single flex-row structure (unaffected by the stacked variant)', () => {
    render(
      <SettingRow label="Max sessions" description="desc">
        <span>3</span>
      </SettingRow>
    )
    const outer = screen.getByText('Max sessions').closest('div')?.parentElement
    expect(outer?.className).toBe('group/row flex items-center gap-4 px-4 py-3')
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

  it('blur without change does not commit; Escape reverts the draft', () => {
    const onCommit = vi.fn()
    render(<DraftInput value="abc" onCommit={onCommit} aria-label="f" />)
    const input = screen.getByLabelText('f') as HTMLInputElement
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'xyz' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('abc')
    fireEvent.blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('DraftTextarea', () => {
  it('Escape reverts the draft; the following blur does not commit', () => {
    const onCommit = vi.fn()
    render(<DraftTextarea value={'line1\nline2'} onCommit={onCommit} aria-label="Draft notes" />)
    const ta = screen.getByLabelText('Draft notes') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'edited' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(ta.value).toBe('line1\nline2')
    fireEvent.blur(ta)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('AnnotatedForm reset affordance', () => {
  it('a select at its defaultValue shows no reset affordance', () => {
    render(
      <AnnotatedForm
        annotations={{
          transport: {
            control: 'select',
            label: 'Transport',
            options: ['http', 'sse'],
            order: 1,
            defaultValue: 'http'
          }
        }}
        value={{ transport: 'http' }}
        onChange={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull()
  })
})

describe('AnnotatedForm sensitive fields', () => {
  const annotations = {
    token: { control: 'password' as const, label: 'API token', order: 1, sensitive: true }
  }

  it('renders a password input that never echoes; set-state shows in the placeholder', () => {
    const onSecret = vi.fn()
    render(
      <AnnotatedForm
        annotations={annotations}
        value={{ token: { $secret: 'connector/rovo/token' } }}
        onChange={vi.fn()}
        onSecret={onSecret}
      />
    )
    const input = screen.getByLabelText('API token') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(input.placeholder).toContain('set')
  })

  it('committing plaintext calls onSecret, not onChange; reset sends null', () => {
    const onSecret = vi.fn()
    const onChange = vi.fn()
    render(
      <AnnotatedForm
        annotations={annotations}
        value={{ token: { $secret: 'connector/rovo/token' } }}
        onChange={onChange}
        onSecret={onSecret}
      />
    )
    const input = screen.getByLabelText('API token')
    fireEvent.change(input, { target: { value: 'hunter2' } })
    fireEvent.blur(input)
    expect(onSecret).toHaveBeenCalledWith('token', 'hunter2')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(onSecret).toHaveBeenCalledWith('token', null)
  })

  it('committed plaintext does not remain in the input after blur', () => {
    const onSecret = vi.fn()
    render(
      <AnnotatedForm
        annotations={annotations}
        value={{ token: { $secret: 'connector/rovo/token' } }}
        onChange={vi.fn()}
        onSecret={onSecret}
      />
    )
    const input = screen.getByLabelText('API token') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hunter2' } })
    fireEvent.blur(input)
    expect(onSecret).toHaveBeenCalledWith('token', 'hunter2')
    expect(input.value).toBe('')
  })

  it('Escape clears the sensitive draft without committing', () => {
    const onSecret = vi.fn()
    render(
      <AnnotatedForm annotations={annotations} value={{}} onChange={vi.fn()} onSecret={onSecret} />
    )
    const input = screen.getByLabelText('API token') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'oops' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    fireEvent.blur(input)
    expect(onSecret).not.toHaveBeenCalled()
  })

  it('not-set state: placeholder says not set, no reset button', () => {
    render(
      <AnnotatedForm annotations={annotations} value={{}} onChange={vi.fn()} onSecret={vi.fn()} />
    )
    const input = screen.getByLabelText('API token') as HTMLInputElement
    expect(input.placeholder).toContain('not set')
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull()
  })
})
