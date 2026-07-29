// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ReposSection } from '../ReposSection'
import { confirm } from '../../lib/confirmStore'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

beforeEach(() => {
  vi.mocked(confirm).mockReset().mockResolvedValue(true)
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
    pr: {
      list: vi.fn(async () => []),
      link: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      search: vi.fn(async () => ({ candidates: [], error: null, searchedRepos: [] }))
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

const BINDING = {
  id: 3,
  caseId: 1,
  repoPath: 'C:\\repos\\hivemindtest',
  owner: 'JiaweiHan88',
  repo: 'hivemindtest',
  number: 16315,
  url: 'https://github.com/JiaweiHan88/hivemindtest/pull/16315',
  source: 'search' as const,
  detectedAt: '2026-07-26T10:00:00Z'
}

const prApi = (): Record<string, ReturnType<typeof vi.fn>> =>
  window.argus.pr as unknown as Record<string, ReturnType<typeof vi.fn>>

describe('ReposSection pull requests', () => {
  it('renders a bound PR as an owner/repo#N chip', async () => {
    prApi().list = vi.fn(async () => [BINDING])
    render(<ReposSection slug="C-1" />)
    expect(await screen.findByText(/JiaweiHan88\/hivemindtest#16315/)).toBeTruthy()
  })

  it('opens the pull request in the browser when the chip is clicked', async () => {
    prApi().list = vi.fn(async () => [BINDING])
    render(<ReposSection slug="C-1" />)
    const chip = await screen.findByRole('button', {
      name: 'Open pull request JiaweiHan88/hivemindtest#16315 on GitHub'
    })
    fireEvent.click(chip)
    expect(window.argus.openExternal).toHaveBeenCalledWith(BINDING.url)
  })

  it('renders no PR section at all when nothing is bound', async () => {
    render(<ReposSection slug="C-1" />)
    await screen.findByText('hivemindtest') // section rendered, PRs empty
    expect(screen.queryByText(/pull requests/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unlink PR' })).toBeNull()
  })

  it('links a typed PR reference', async () => {
    render(<ReposSection slug="C-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
    const box = screen.getByPlaceholderText(/pr url/i)
    fireEvent.change(box, { target: { value: 'JiaweiHan88/hivemindtest#16315' } })
    fireEvent.submit(box)
    await waitFor(() =>
      expect(prApi().link).toHaveBeenCalledWith('C-1', 'JiaweiHan88/hivemindtest#16315')
    )
    // no PR was bound yet, so replacing nothing needs no confirmation
    expect(confirm).not.toHaveBeenCalled()
  })

  // addBinding replaces rather than adds: linking a second PR over an already-bound one
  // silently retargets any existing findings' comment/push actions unless the user is warned.
  describe('replacing an already-bound PR', () => {
    async function openDraftAndSubmit(value: string): Promise<void> {
      render(<ReposSection slug="C-1" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
      const box = screen.getByPlaceholderText(/pr url/i)
      fireEvent.change(box, { target: { value } })
      fireEvent.submit(box)
    }

    it('raises a confirm naming the current and new pull request', async () => {
      prApi().list = vi.fn(async () => [BINDING])
      await openDraftAndSubmit('JiaweiHan88/hivemindtest#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('JiaweiHan88/hivemindtest#16315')
        })
      )
      expect(vi.mocked(confirm).mock.calls[0][0].title).toContain('JiaweiHan88/hivemindtest#99')
    })

    it('declining leaves the binding untouched and calls no IPC', async () => {
      vi.mocked(confirm).mockResolvedValue(false)
      prApi().list = vi.fn(async () => [BINDING])
      await openDraftAndSubmit('JiaweiHan88/hivemindtest#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      // give any (incorrect) fire-and-forget link() call a chance to have happened
      await new Promise((r) => setTimeout(r, 0))
      expect(prApi().link).not.toHaveBeenCalled()
    })

    it('accepting proceeds to link the new pull request', async () => {
      vi.mocked(confirm).mockResolvedValue(true)
      prApi().list = vi.fn(async () => [BINDING])
      await openDraftAndSubmit('JiaweiHan88/hivemindtest#99')
      await waitFor(() =>
        expect(prApi().link).toHaveBeenCalledWith('C-1', 'JiaweiHan88/hivemindtest#99')
      )
    })

    // Re-review fix: `linkingPr` (and so the disabled input) now gates BEFORE the confirm
    // await, matching the restructuring PrPickerDialog's `confirm()` got this round — a
    // double-click could otherwise race the await and raise the confirm dialog twice.
    it('disables the input while the replace-confirm itself is pending, not just the link', async () => {
      let resolveConfirm!: (v: boolean) => void
      vi.mocked(confirm).mockImplementation(() => new Promise((r) => (resolveConfirm = r)))
      prApi().list = vi.fn(async () => [BINDING])
      await openDraftAndSubmit('JiaweiHan88/hivemindtest#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      expect(screen.getByPlaceholderText(/linking/i)).toBeDisabled()

      resolveConfirm(true)
      await waitFor(() =>
        expect(prApi().link).toHaveBeenCalledWith('C-1', 'JiaweiHan88/hivemindtest#99')
      )
    })
  })

  // Re-review fix: retyping the ALREADY-bound PR (a no-op for addBinding, which is
  // idempotent on identity) must not scare the user with a "replace" warning about
  // findings retargeting — nothing retargets when the identity doesn't change.
  describe('re-linking the SAME pull request', () => {
    async function openDraftAndSubmit(value: string): Promise<void> {
      render(<ReposSection slug="C-1" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
      const box = screen.getByPlaceholderText(/pr url/i)
      fireEvent.change(box, { target: { value } })
      fireEvent.submit(box)
    }

    it('no confirm for the canonical url spelling', async () => {
      prApi().list = vi.fn(async () => [BINDING])
      await openDraftAndSubmit(BINDING.url)
      await waitFor(() => expect(prApi().link).toHaveBeenCalledWith('C-1', BINDING.url))
      expect(confirm).not.toHaveBeenCalled()
    })

    it('no confirm for the owner/repo#n spelling', async () => {
      prApi().list = vi.fn(async () => [BINDING])
      await openDraftAndSubmit('JiaweiHan88/hivemindtest#16315')
      await waitFor(() =>
        expect(prApi().link).toHaveBeenCalledWith('C-1', 'JiaweiHan88/hivemindtest#16315')
      )
      expect(confirm).not.toHaveBeenCalled()
    })

    it('still confirms a spelling of a genuinely different pull request', async () => {
      prApi().list = vi.fn(async () => [BINDING])
      await openDraftAndSubmit('JiaweiHan88/hivemindtest#99')
      await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    })
  })

  // Re-review fix: pr:link now runs a git fetch + worktree add unconditionally (see
  // prLink.ts), not just a DB write — the input must show it is busy and refuse a second
  // submit while the first is still in flight.
  it('disables the input while a link is in flight and re-enables after', async () => {
    let resolveLink: (() => void) | undefined
    prApi().link = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLink = resolve
        })
    )
    render(<ReposSection slug="C-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link PR' }))
    const box = screen.getByPlaceholderText(/pr url/i)
    fireEvent.change(box, { target: { value: 'JiaweiHan88/hivemindtest#16315' } })
    fireEvent.submit(box)
    await waitFor(() => expect(box).toBeDisabled())

    // a second submit while linking is in flight must not fire a second IPC call
    fireEvent.change(box, { target: { value: 'JiaweiHan88/hivemindtest#77' } })
    fireEvent.submit(box)
    expect(prApi().link).toHaveBeenCalledTimes(1)

    // a successful link clears the draft and closes the form (setPrDraft(null)), so the
    // input itself unmounts — assert re-enablement indirectly via the form disappearing
    // rather than the (by-then-detached) input node.
    resolveLink!()
    await waitFor(() => expect(screen.queryByPlaceholderText(/pr url/i)).toBeNull())
  })

  // The only way to reopen the picker once PRs are bound, and the recovery path for a
  // search that failed or found nothing.
  it('re-runs the search on demand and hands the result to the picker', async () => {
    const onFound = vi.fn()
    const result = { candidates: [], error: null, searchedRepos: ['JiaweiHan88/hivemindtest'] }
    prApi().search = vi.fn(async () => result)
    render(<ReposSection slug="C-1" onPrsFound={onFound} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Find PRs' }))
    await waitFor(() => expect(prApi().search).toHaveBeenCalledWith('C-1'))
    await waitFor(() => expect(onFound).toHaveBeenCalledWith(result))
  })

  it('unlinks a PR by its binding id and refreshes', async () => {
    prApi().list = vi.fn(async () => [BINDING])
    render(<ReposSection slug="C-1" />)
    await screen.findByText(/JiaweiHan88\/hivemindtest#16315/)
    const before = prApi().list.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Unlink PR' }))
    await waitFor(() => expect(prApi().unlink).toHaveBeenCalledWith('C-1', 3))
    await waitFor(() => expect(prApi().list.mock.calls.length).toBeGreaterThan(before))
  })
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

  it('keeps the unlink-PR button in review mode (switching PRs is a review operation)', async () => {
    prApi().list = vi.fn(async () => [BINDING])
    render(<ReposSection slug="C-1" mode="review" />)
    expect(await screen.findByRole('button', { name: 'Unlink PR' })).toBeInTheDocument()
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
