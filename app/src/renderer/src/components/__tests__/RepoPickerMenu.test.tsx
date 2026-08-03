// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RepoPickerMenu } from '../RepoPickerMenu'

const ALPHA = 'C:\\repos\\alpha'
const BETA = 'C:\\repos\\beta'
const GAMMA = 'C:\\repos\\gamma'

function stubArgus(recent: { path: string; name: string }[], picked: string | null): void {
  window.argus = {
    workspaces: {
      recent: vi.fn(async () => recent),
      pick: vi.fn(async () => picked)
    }
  } as never
}

beforeEach(() => {
  stubArgus([], null)
})

describe('RepoPickerMenu', () => {
  it('lists recents minus the excluded paths', async () => {
    stubArgus(
      [
        { path: ALPHA, name: 'alpha' },
        { path: BETA, name: 'beta' }
      ],
      null
    )
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[BETA]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    expect(await screen.findByRole('menuitem', { name: 'alpha' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'beta' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Browse…' })).toBeInTheDocument()
  })

  it('excludes a path that differs only by a trailing separator, going straight to the dialog', async () => {
    // The only recent entry is excluded via a trailing-separator variant of its path. If
    // `sameRepo` failed to normalize that away, this would be treated as NOT excluded, `offered`
    // would be non-empty, and a menu (not the direct-dialog fallback) would render instead.
    stubArgus([{ path: ALPHA, name: 'alpha' }], BETA)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[`${ALPHA}\\`]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(BETA))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('reports the chosen recent path', async () => {
    stubArgus([{ path: ALPHA, name: 'alpha' }], null)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'alpha' }))
    expect(onPick).toHaveBeenCalledWith(ALPHA)
  })

  it('Browse… opens the native dialog and reports its result', async () => {
    stubArgus([{ path: ALPHA, name: 'alpha' }], BETA)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Browse…' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(BETA))
  })

  it('a cancelled dialog reports nothing', async () => {
    stubArgus([{ path: ALPHA, name: 'alpha' }], null)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Browse…' }))
    await waitFor(() => expect(window.argus.workspaces.pick).toHaveBeenCalled())
    expect(onPick).not.toHaveBeenCalled()
  })

  it('with no usable recents the trigger opens the dialog directly, rendering no menu', async () => {
    stubArgus([], BETA)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(BETA))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('with a non-empty history that is entirely excluded, the trigger opens the dialog directly, rendering no menu', async () => {
    // Two recent entries, both excluded. If the fallback still keyed on the raw `recent.length`
    // instead of the post-exclusion `offered.length`, this history is non-empty so the branch
    // would be skipped and a Browse…-only menu would render instead of going direct to dialog.
    // The dialog itself returns GAMMA — a path NOT in `exclude` — so this stays a test of the
    // direct-dialog fallback rather than of Browse…'s own exclude check (covered separately).
    stubArgus(
      [
        { path: ALPHA, name: 'alpha' },
        { path: BETA, name: 'beta' }
      ],
      GAMMA
    )
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[ALPHA, BETA]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(GAMMA))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('reports the full path as the row title, so same-named repos in different folders stay distinguishable', async () => {
    stubArgus([{ path: ALPHA, name: 'alpha' }], null)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    expect(await screen.findByRole('menuitem', { name: 'alpha' })).toHaveAttribute('title', ALPHA)
  })

  it('Browse… does not report a picked path that is already excluded, so Settings cannot append a duplicate default', async () => {
    // BETA stays in the recents list (not excluded) so the menu renders instead of the
    // direct-dialog fallback; the native dialog then returns ALPHA, which IS excluded.
    stubArgus([{ path: BETA, name: 'beta' }], ALPHA)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[ALPHA]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Browse…' }))
    await waitFor(() => expect(window.argus.workspaces.pick).toHaveBeenCalled())
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Browse… still reports a picked path that is NOT excluded', async () => {
    stubArgus([{ path: BETA, name: 'beta' }], ALPHA)
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Browse…' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(ALPHA))
  })

  it('a rejected pick() from Browse… is handled without an unhandled rejection, leaving the button usable', async () => {
    stubArgus([{ path: ALPHA, name: 'alpha' }], null)
    window.argus.workspaces.pick = vi.fn(async () => {
      throw new Error('dialog failed')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Browse…' }))
    await waitFor(() => expect(window.argus.workspaces.pick).toHaveBeenCalled())
    expect(onPick).not.toHaveBeenCalled()
    // the button is still there and clickable — no dead trigger
    expect(await screen.findByRole('button', { name: 'Add…' })).toBeInTheDocument()
    warn.mockRestore()
  })

  it('survives a rejected recent() by falling back to the direct dialog', async () => {
    window.argus = {
      workspaces: {
        recent: vi.fn(async () => {
          throw new Error('ipc down')
        }),
        pick: vi.fn(async () => BETA)
      }
    } as never
    const onPick = vi.fn()
    render(<RepoPickerMenu onPick={onPick} exclude={[]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(BETA))
  })
})
