// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RepoGraphControl } from '../RepoGraphControl'
import type { GraphProgress, GraphStatusRow } from '../../../../shared/types'

const none: GraphStatusRow = {
  scope: null,
  scopeKey: '_root',
  status: 'none',
  commit: null,
  behind: null,
  builtAt: null,
  nodeCount: null
}
const building: GraphStatusRow = { ...none, status: 'building' }
const ok: GraphStatusRow = {
  ...none,
  status: 'ok',
  commit: 'ab12cd34ef',
  behind: 2,
  builtAt: '2026-07-12T10:00:00Z',
  nodeCount: 9171
}

let progressCb: ((p: GraphProgress) => void) | null = null

beforeEach(() => {
  progressCb = null
  window.argus = {
    graph: {
      status: vi.fn(async () => [none]),
      build: vi.fn(async () => ({ started: true })),
      install: vi.fn(async () => ({ ok: true, log: '' })),
      onBuilding: vi.fn(() => () => {}),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn((cb: (p: GraphProgress) => void) => {
        progressCb = cb
        return () => {}
      })
    }
  } as never
})

describe('RepoGraphControl', () => {
  it('opens the popover and starts a build', async () => {
    render(<RepoGraphControl repoPath={'C:\\code\\navigator'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code graph' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Build code graph' }))
    await waitFor(() =>
      expect(window.argus.graph.build).toHaveBeenCalledWith('C:\\code\\navigator', null)
    )
  })

  it('passes the scope input to build', async () => {
    render(<RepoGraphControl repoPath={'C:\\code\\navigator'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code graph' }))
    fireEvent.change(await screen.findByPlaceholderText('limit to subpath (optional)'), {
      target: { value: 'src/routing' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Build code graph' }))
    await waitFor(() =>
      expect(window.argus.graph.build).toHaveBeenCalledWith('C:\\code\\navigator', 'src/routing')
    )
  })

  it('shows built status with short commit and behind count, offers Refresh', async () => {
    window.argus.graph.status = vi.fn(async () => [ok])
    render(<RepoGraphControl repoPath={'C:\\code\\navigator'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code graph' }))
    expect(await screen.findByText(/graph @ ab12cd3/)).toBeTruthy()
    expect(screen.getByText(/2 behind/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh graph' })).toBeTruthy()
  })

  it('offers install when graphify is missing, retries build after install', async () => {
    window.argus.graph.build = vi
      .fn()
      .mockResolvedValueOnce({ started: false, missing: true })
      .mockResolvedValueOnce({ started: true })
    render(<RepoGraphControl repoPath={'C:\\code\\navigator'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code graph' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Build code graph' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install graphify' }))
    await waitFor(() => expect(window.argus.graph.install).toHaveBeenCalled())
    await waitFor(() => expect(window.argus.graph.build).toHaveBeenCalledTimes(2))
  })

  it('shows a live progress message and percent bar while building', async () => {
    window.argus.graph.status = vi.fn(async () => [building])
    render(<RepoGraphControl repoPath={'C:\\code\\navigator'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code graph' }))
    expect(await screen.findByText('building…')).toBeTruthy()
    progressCb?.({
      repoPath: 'C:\\code\\navigator',
      scope: null,
      message: 'AST extraction: 50/100 files (50%)',
      percent: 50
    })
    expect(await screen.findByText('AST extraction: 50/100 files (50%)')).toBeTruthy()
  })

  it('shows the install log when install fails', async () => {
    window.argus.graph.build = vi.fn(async () => ({ started: false, missing: true as const }))
    window.argus.graph.install = vi.fn(async () => ({
      ok: false,
      log: 'Neither uv nor pipx found.'
    }))
    render(<RepoGraphControl repoPath={'C:\\code\\navigator'} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Code graph' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Build code graph' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install graphify' }))
    expect(await screen.findByText(/Neither uv nor pipx found/)).toBeTruthy()
  })
})
