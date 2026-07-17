// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ReposSection } from '../ReposSection'

beforeEach(() => {
  window.argus = {
    workspaces: {
      list: vi.fn(async () => [
        {
          path: 'C:\\repos\\hivemindtest',
          remote: null,
          branch: 'main',
          currentRef: 'main',
          dirty: true,
          worktreePath: null
        }
      ]),
      refs: vi.fn(async () => [
        { remote: 'git@github.com:x/imported.git', branch: 'main', commit: 'abcdef1234' }
      ]),
      pick: vi.fn(async () => null),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined)
    },
    graph: {
      status: vi.fn(async () => []),
      build: vi.fn(async () => ({ started: true })),
      install: vi.fn(async () => ({ ok: true, log: '' })),
      onBuilding: vi.fn(() => () => {}),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => {})
    }
  } as never
})

describe('ReposSection', () => {
  it('renders linked repo chips with ref and dirty marker', async () => {
    render(<ReposSection slug="C-1" />)
    expect(await screen.findByText(/hivemindtest @ main/)).toBeTruthy()
    expect(screen.getByText(/●/)).toBeTruthy()
  })

  it('renders imported unlinked refs', async () => {
    render(<ReposSection slug="C-1" />)
    expect(await screen.findByText(/imported @ abcdef1 · unlinked/)).toBeTruthy()
  })

  it('unlink calls the IPC and reloads', async () => {
    render(<ReposSection slug="C-1" />)
    await screen.findByText(/hivemindtest/)
    fireEvent.click(screen.getByRole('button', { name: 'Unlink repo' }))
    await waitFor(() =>
      expect(
        (window.argus.workspaces as unknown as { unlink: ReturnType<typeof vi.fn> }).unlink
      ).toHaveBeenCalledWith('C-1', 'C:\\repos\\hivemindtest')
    )
  })

  it('has a link-repo button that opens the picker', async () => {
    render(<ReposSection slug="C-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Link repo' }))
    await waitFor(() =>
      expect(
        (window.argus.workspaces as unknown as { pick: ReturnType<typeof vi.fn> }).pick
      ).toHaveBeenCalled()
    )
  })

  // Ported from HeaderRepos.test.tsx: "links a picked repo via + repo" — asserts
  // that a non-null pick() result is actually threaded through to link() with the
  // case slug and picked path (the brief's minimal test above only checks that
  // pick() was called, not what happens with its result).
  it('links a picked repo via the Link repo button', async () => {
    window.argus.workspaces.pick = vi.fn(async () => 'C:\\code\\other')
    render(<ReposSection slug="C-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link repo' }))
    await waitFor(() =>
      expect(window.argus.workspaces.link).toHaveBeenCalledWith('C-1', 'C:\\code\\other')
    )
  })

  it('reloads on a workspaces:changed broadcast for this case only', async () => {
    let fire: ((slug: string) => void) | undefined
    ;(window.argus.workspaces as unknown as { onChanged: unknown }).onChanged = vi.fn(
      (cb: (slug: string) => void) => {
        fire = cb
        return () => undefined
      }
    )
    render(<ReposSection slug="C-1" />)
    await screen.findByText(/hivemindtest/)
    const list = (window.argus.workspaces as unknown as { list: ReturnType<typeof vi.fn> }).list
    const before = list.mock.calls.length
    fire!('C-1')
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before))
    const after = list.mock.calls.length
    fire!('OTHER-CASE')
    await new Promise((r) => setTimeout(r, 0))
    expect(list.mock.calls.length).toBe(after)
  })
})
