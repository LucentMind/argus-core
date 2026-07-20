// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ConfirmHost } from '../ConfirmHost'
import { confirm, alert } from '../../lib/confirmStore'

describe('ConfirmHost', () => {
  it('renders nothing until a prompt is requested', () => {
    render(<ConfirmHost />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resolves true when the confirm button is clicked', async () => {
    render(<ConfirmHost />)
    const p = confirm({ title: 'Archive nav-drift?', message: 'It stops being injected.' })
    expect(await screen.findByText('Archive nav-drift?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await p).toBe(true)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('resolves false when cancelled', async () => {
    render(<ConfirmHost />)
    const p = confirm({ title: 'Delete file?' })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await p).toBe(false)
  })

  it('resolves false when the backdrop is clicked', async () => {
    render(<ConfirmHost />)
    const p = confirm({ title: 'Delete file?' })
    fireEvent.click(await screen.findByTestId('modal-backdrop'))
    expect(await p).toBe(false)
  })

  it('uses a custom danger confirm label', async () => {
    render(<ConfirmHost />)
    const p = confirm({ title: 'Delete case?', confirmLabel: 'Delete case', danger: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Delete case' }))
    expect(await p).toBe(true)
  })

  it('alert shows a single OK button and resolves on dismiss', async () => {
    render(<ConfirmHost />)
    const p = alert('secret not saved: boom')
    expect(await screen.findByText('secret not saved: boom')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await expect(p).resolves.toBeUndefined()
  })

  it('a newer prompt supersedes an older one as cancelled', async () => {
    render(<ConfirmHost />)
    const first = confirm({ title: 'First?' })
    const second = confirm({ title: 'Second?' })
    expect(await first).toBe(false)
    expect(await screen.findByText('Second?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await second).toBe(true)
  })
})
