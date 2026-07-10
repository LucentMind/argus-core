// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeaderRepos } from '../HeaderRepos'
import type { WorkspaceInfo } from '../../../../shared/types'

const ws: WorkspaceInfo = {
  path: 'C:\\code\\navigator',
  remote: null,
  branch: 'main',
  currentRef: 'main',
  dirty: true,
  worktreePath: null
}

beforeEach(() => {
  window.argus = {
    workspaces: {
      list: vi.fn(async () => [ws]),
      pick: vi.fn(async () => null),
      link: vi.fn(async () => ws),
      unlink: vi.fn(async () => undefined)
    }
  } as never
})

describe('HeaderRepos', () => {
  it('renders a chip with name @ ref and dirty marker', async () => {
    render(<HeaderRepos slug="NAV-1" />)
    expect(await screen.findByText(/navigator @ main ●/)).toBeTruthy()
  })

  it('links a picked repo via + repo', async () => {
    window.argus.workspaces.pick = vi.fn(async () => 'C:\\code\\other')
    render(<HeaderRepos slug="NAV-1" />)
    fireEvent.click(await screen.findByRole('button', { name: '+ repo' }))
    await waitFor(() =>
      expect(window.argus.workspaces.link).toHaveBeenCalledWith('NAV-1', 'C:\\code\\other')
    )
  })

  it('unlinks from the chip ×', async () => {
    render(<HeaderRepos slug="NAV-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink repo' }))
    await waitFor(() =>
      expect(window.argus.workspaces.unlink).toHaveBeenCalledWith('NAV-1', 'C:\\code\\navigator')
    )
  })
})
