// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { DeleteCaseDialog } from '../DeleteCaseDialog'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'

afterEach(() => __resetEscapeLayersForTest())

beforeEach(() => {
  window.argus = { cases: { delete: vi.fn(async () => undefined) } } as never
})

describe('DeleteCaseDialog', () => {
  it('Escape cancels immediately from the confirm field, even with text typed', async () => {
    const onCancel = vi.fn()
    render(<DeleteCaseDialog slug="C-1" onCancel={onCancel} onDeleted={vi.fn()} />)
    const field = screen.getByLabelText('Confirm slug')
    await userEvent.type(field, 'C-')
    expect(field).toHaveFocus() // autoFocus + typing: Escape lands on a field
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape cancels from the confirm field when it is empty', async () => {
    const onCancel = vi.fn()
    render(<DeleteCaseDialog slug="C-1" onCancel={onCancel} onDeleted={vi.fn()} />)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the dialog without deleting when focus is off the field', async () => {
    const onCancel = vi.fn()
    render(<DeleteCaseDialog slug="C-1" onCancel={onCancel} onDeleted={vi.fn()} />)
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
  })
})
