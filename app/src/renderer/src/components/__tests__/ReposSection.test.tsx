// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ReposSection } from '../ReposSection'
import { uiStore } from '../../lib/uiStore'
import type { LinkWorkspaceResult } from '../../../../shared/types'
import { confirmStore } from '../../lib/confirmStore'

beforeEach(() => {
  uiStore.setDynamicTheme(false)
  localStorage.clear()
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
      recent: vi.fn(async () => []),
      link: vi.fn(async () => ({
        workspace: {
          path: 'C:\\repos\\hivemindtest',
          remote: null,
          branch: 'main',
          currentRef: 'main',
          dirty: false,
          worktreePath: null
        },
        suggestDefault: false,
        caseCount: 1
      })),
      setDefault: vi.fn(async () => undefined),
      dismissPromote: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined)
    },
    graph: {
      status: vi.fn(async () => []),
      build: vi.fn(async () => ({ started: true })),
      install: vi.fn(async () => ({ ok: true, log: '' })),
      onBuilding: vi.fn(() => () => {}),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => {})
    },
    openExternal: vi.fn(async () => undefined)
  } as never
})

describe('ReposSection mode gating', () => {
  it('hides unlink-repo and code-graph icons in review mode', async () => {
    render(<ReposSection slug="C-1" mode="review" />)
    await screen.findByText('hivemindtest')
    expect(screen.queryByRole('button', { name: 'Unlink repo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Code graph' })).toBeNull()
  })

  it('keeps both icons in investigation mode', async () => {
    render(<ReposSection slug="C-1" mode="investigation" />)
    await screen.findByText('hivemindtest')
    expect(screen.getByRole('button', { name: 'Unlink repo' })).toBeInTheDocument()
  })
})

describe('ReposSection', () => {
  it('renders linked repo chips with ref and dirty marker', async () => {
    render(<ReposSection slug="C-1" />)
    expect(await screen.findByText('hivemindtest')).toBeTruthy()
    expect(screen.getByTitle('main')).toBeTruthy()
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
    fireEvent.click(await screen.findByRole('button', { name: 'Link repo' }))
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

describe('ReposSection repo chip layout', () => {
  it('shows the repo name and branch on separate lines, with the full branch in a tooltip', async () => {
    render(<ReposSection slug="C-1" />)
    const name = await screen.findByText('hivemindtest')
    const branch = screen.getByTitle('main')
    expect(name).toBeInTheDocument()
    // separate elements, not one run-on string
    expect(branch).not.toBe(name)
    expect(name.textContent).not.toContain('main')
  })

  it('marks a worktree checkout with its own badge rather than a text suffix', async () => {
    ;(window.argus.workspaces.list as ReturnType<typeof vi.fn>) = vi.fn(async () => [
      {
        path: 'C:\\repos\\hivemindtest',
        remote: null,
        branch: 'main',
        currentRef: 'main',
        dirty: false,
        worktreePath: 'C:\\wt\\x'
      }
    ])
    render(<ReposSection slug="C-1" />)
    expect(await screen.findByText('worktree')).toBeInTheDocument()
  })

  it('omits the worktree badge for a plain (non-worktree) checkout', async () => {
    // default beforeEach mock has worktreePath: null — only the positive case above was
    // covered before, so a regression that always renders the badge would have passed.
    render(<ReposSection slug="C-1" />)
    await screen.findByText('hivemindtest')
    expect(screen.queryByText('worktree')).toBeNull()
  })
})

describe('ReposSection pending states', () => {
  it('shows a chip with the picked repo name while linking', async () => {
    window.argus.workspaces.pick = vi.fn(async () => 'C:\\repos\\argus-core')
    let release: () => void = () => {}
    window.argus.workspaces.link = vi.fn(
      () =>
        new Promise<LinkWorkspaceResult>((res) => {
          release = () =>
            res({
              workspace: {
                path: 'C:\\repos\\argus-core',
                remote: null,
                branch: 'main',
                currentRef: 'main',
                dirty: false,
                worktreePath: null
              },
              suggestDefault: false,
              caseCount: 1
            })
        })
    )
    render(<ReposSection slug="C-1" />)
    await screen.findByText('hivemindtest')

    fireEvent.click(screen.getByRole('button', { name: 'Link repo' }))

    expect(await screen.findByText('argus-core')).toBeInTheDocument()

    await act(async () => {
      release()
    })
  })

  it('surfaces a link failure on the chip instead of swallowing it', async () => {
    window.argus.workspaces.pick = vi.fn(async () => 'C:\\not-a-repo')
    window.argus.workspaces.link = vi.fn(() =>
      Promise.reject(new Error('Not a git repository: C:\\not-a-repo'))
    )
    render(<ReposSection slug="C-1" />)
    await screen.findByText('hivemindtest')

    fireEvent.click(screen.getByRole('button', { name: 'Link repo' }))

    expect(await screen.findByTitle('Not a git repository: C:\\not-a-repo')).toBeInTheDocument()
  })

  it('surfaces an unlink failure', async () => {
    window.argus.workspaces.unlink = vi.fn(() => Promise.reject(new Error('worktree is locked')))
    render(<ReposSection slug="C-1" />)
    await screen.findByText('hivemindtest')

    fireEvent.click(screen.getByRole('button', { name: 'Unlink repo' }))

    expect(await screen.findByTitle('worktree is locked')).toBeInTheDocument()
  })
})

describe('ReposSection material', () => {
  it('carries the panel material when the dynamic theme is on', async () => {
    uiStore.setDynamicTheme(true)
    const { container } = render(<ReposSection slug="C-1" mode="investigation" />)
    await waitFor(() => expect(container.querySelector('.glass-panel')).not.toBeNull())
  })

  // Reversed on 2026-08-02 (user-directed): classic used to carry no material here at all,
  // which on a pure-black rail left Jira, Repos and the PR section as three unbounded stacks
  // of text. Classic now takes `surface-card` — the app's existing matte material — in the
  // same box, with the same padding and radius as the dynamic theme's glass.
  it('carries the matte material when the dynamic theme is off', async () => {
    uiStore.setDynamicTheme(false)
    const { container } = render(<ReposSection slug="C-1" mode="investigation" />)
    await screen.findByText('hivemindtest')
    expect(container.querySelector('.glass-panel')).toBeNull()
    expect(container.querySelector('.surface-card')).not.toBeNull()
  })

  it('gives both themes the same pane box', async () => {
    for (const dynamic of [true, false]) {
      uiStore.setDynamicTheme(dynamic)
      const { container, unmount } = render(<ReposSection slug="C-1" mode="investigation" />)
      await screen.findByText('hivemindtest')
      const root = container.firstElementChild
      expect(root?.className, `dynamic=${dynamic}`).toMatch(/(^|\s)p-2\.5(\s|$)/)
      expect(root?.className, `dynamic=${dynamic}`).toMatch(/(^|\s)rounded-r3(\s|$)/)
      unmount()
    }
  })
})

/** Answer the single pending confirm() the way a user would. `settle(id, choice)` is the
 *  store's own API — it clears `current` as well as resolving, which a bare `resolve` call
 *  would not. The store keeps at most one prompt, so polling for it is enough; no
 *  `<ConfirmHost/>` render is required. */
async function answerConfirm(choice: 'confirm' | 'cancel'): Promise<void> {
  await waitFor(() => expect(confirmStore.get().current).not.toBeNull())
  const { id } = confirmStore.get().current!
  await act(async () => {
    confirmStore.settle(id, choice)
  })
}

describe('ReposSection promote-to-default prompt', () => {
  it('offers to make a repeatedly-linked repo a default, and records the acceptance', async () => {
    window.argus.workspaces.recent = vi.fn(async () => [
      { path: 'C:\\repos\\alpha', name: 'alpha' }
    ])
    window.argus.workspaces.link = vi.fn(async () => ({
      workspace: {
        path: 'C:\\repos\\alpha',
        remote: null,
        branch: 'main',
        currentRef: 'main',
        dirty: false,
        worktreePath: null
      },
      suggestDefault: true,
      caseCount: 3
    }))
    render(<ReposSection slug="C-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Link repo' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'alpha' }))
    await answerConfirm('confirm')

    expect(window.argus.workspaces.setDefault).toHaveBeenCalledWith('C:\\repos\\alpha')
    expect(window.argus.workspaces.dismissPromote).not.toHaveBeenCalled()
  })

  it('declining silences the prompt for that repo permanently', async () => {
    window.argus.workspaces.recent = vi.fn(async () => [
      { path: 'C:\\repos\\alpha', name: 'alpha' }
    ])
    window.argus.workspaces.link = vi.fn(async () => ({
      workspace: {
        path: 'C:\\repos\\alpha',
        remote: null,
        branch: 'main',
        currentRef: 'main',
        dirty: false,
        worktreePath: null
      },
      suggestDefault: true,
      caseCount: 4
    }))
    render(<ReposSection slug="C-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Link repo' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'alpha' }))
    await answerConfirm('cancel')

    expect(window.argus.workspaces.dismissPromote).toHaveBeenCalledWith('C:\\repos\\alpha')
    expect(window.argus.workspaces.setDefault).not.toHaveBeenCalled()
  })

  it('does not prompt when the link does not suggest it', async () => {
    window.argus.workspaces.recent = vi.fn(async () => [
      { path: 'C:\\repos\\alpha', name: 'alpha' }
    ])
    render(<ReposSection slug="C-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Link repo' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'alpha' }))
    await waitFor(() => expect(window.argus.workspaces.link).toHaveBeenCalled())
    expect(confirmStore.get().current).toBeNull()
  })

  it('a failing setDefault does not turn a completed link into an error chip', async () => {
    window.argus.workspaces.recent = vi.fn(async () => [
      { path: 'C:\\repos\\alpha', name: 'alpha' }
    ])
    window.argus.workspaces.link = vi.fn(async () => ({
      workspace: {
        path: 'C:\\repos\\alpha',
        remote: null,
        branch: 'main',
        currentRef: 'main',
        dirty: false,
        worktreePath: null
      },
      suggestDefault: true,
      caseCount: 3
    }))
    window.argus.workspaces.setDefault = vi.fn(async () => {
      throw new Error('settings locked')
    })
    render(<ReposSection slug="C-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Link repo' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'alpha' }))
    await answerConfirm('confirm')

    expect(screen.queryByText('settings locked')).not.toBeInTheDocument()
  })

  it('excludes an already-linked repo from the dropdown', async () => {
    // the beforeEach stub already reports hivemindtest as linked
    window.argus.workspaces.recent = vi.fn(async () => [
      { path: 'C:\\repos\\hivemindtest', name: 'hivemindtest' },
      { path: 'C:\\repos\\alpha', name: 'alpha' }
    ])
    render(<ReposSection slug="C-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Link repo' }))
    expect(await screen.findByRole('menuitem', { name: 'alpha' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'hivemindtest' })).not.toBeInTheDocument()
  })
})
