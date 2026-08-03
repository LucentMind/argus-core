// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { RepoPickerMenu } from '../RepoPickerMenu'

const ALPHA = 'C:\\repos\\alpha'
const BETA = 'C:\\repos\\beta'

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

  it('excludes a path that differs only by a trailing separator', async () => {
    stubArgus([{ path: ALPHA, name: 'alpha' }], null)
    render(<RepoPickerMenu onPick={vi.fn()} exclude={[`${ALPHA}\\`]} trigger={{ text: 'Add…' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }))
    await screen.findByRole('menuitem', { name: 'Browse…' })
    expect(screen.queryByRole('menuitem', { name: 'alpha' })).not.toBeInTheDocument()
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
