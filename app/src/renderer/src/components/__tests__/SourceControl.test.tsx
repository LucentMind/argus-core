// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SourceControl } from '../settings/SourceControl'
import type { SourceControlStatus } from '../../../../shared/sourcecontrol'

let status: SourceControlStatus

beforeEach(() => {
  status = {
    installed: true,
    version: 'gh version 2.96.0 (2026-07-02)',
    authenticated: true,
    login: 'jiawiehan',
    detail: 'Logged in to github.com account jiawiehan'
  }
  window.argus = {
    sourceControl: { status: vi.fn(() => Promise.resolve(status)) }
  } as never
})

describe('SourceControl', () => {
  it('authenticated: green state, version, login', async () => {
    render(<SourceControl />)
    expect(await screen.findByText('GitHub')).toBeTruthy()
    expect(screen.getByText('gh version 2.96.0 (2026-07-02)')).toBeTruthy()
    expect(screen.getByText('Authenticated as')).toBeTruthy()
    expect(screen.getByLabelText('Toggle GitHub login visibility')).toBeTruthy()
    expect(screen.getByTestId('sc-dot-github').dataset.state).toBe('ok')
  })

  it('blurs the github login and reveals the real value on click', async () => {
    render(<SourceControl />)
    await screen.findByText('GitHub')
    const loginBtn = screen.getByLabelText('Toggle GitHub login visibility')
    expect(loginBtn.textContent).not.toBe('jiawiehan')
    fireEvent.click(loginBtn)
    expect(loginBtn.textContent).toBe('jiawiehan')
  })

  it('unauthenticated: red state + hint', async () => {
    status = {
      installed: true,
      version: 'gh version 2.96.0',
      authenticated: false,
      login: null,
      detail: 'not logged in'
    }
    render(<SourceControl />)
    expect(await screen.findByText(/gh auth login/)).toBeTruthy()
    expect(screen.getByTestId('sc-dot-github').dataset.state).toBe('fail')
  })

  it('status fetch rejects: falls back to "status unavailable", dim state', async () => {
    window.argus = {
      sourceControl: { status: vi.fn(() => Promise.reject(new Error('ipc failed'))) }
    } as never
    render(<SourceControl />)
    expect(await screen.findByText('status unavailable')).toBeTruthy()
    expect(screen.getByTestId('sc-dot-github').dataset.state).toBe('off')
  })

  it('not installed: dim state', async () => {
    status = {
      installed: false,
      version: null,
      authenticated: false,
      login: null,
      detail: 'gh not installed'
    }
    render(<SourceControl />)
    expect(await screen.findByText(/gh not installed/)).toBeTruthy()
    expect(screen.getByTestId('sc-dot-github').dataset.state).toBe('off')
  })
})
