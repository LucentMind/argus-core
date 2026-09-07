// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { HivemindInitDialog } from '../HivemindInitDialog'
import { confirm } from '../../../lib/confirmStore'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

function stubArgus(
  init: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    ok: true as const,
    outcome: 'created' as const,
    prUrl: 'https://github.com/acme/hivemind/pull/9'
  })),
  initPreview: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    noCommits: false,
    readme: '# Argus HiveMind\n',
    missing: ['README.md', 'skills/.gitkeep']
  }))
): { init: ReturnType<typeof vi.fn>; initPreview: ReturnType<typeof vi.fn> } {
  ;(window as never as { argus: unknown }).argus = {
    hivemind: { init, initPreview },
    openExternal: vi.fn()
  }
  return { init, initPreview }
}

beforeEach(() => {
  vi.mocked(confirm).mockClear()
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('HivemindInitDialog', () => {
  it('previews the missing files and README, then opens a pull request with no confirm gate', async () => {
    const { init } = stubArgus()
    const onDone = vi.fn()
    render(<HivemindInitDialog onClose={vi.fn()} onDone={onDone} />)
    expect(await screen.findByText('Adds: README.md, skills/.gitkeep')).toBeInTheDocument()
    expect(screen.getByText('# Argus HiveMind')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))

    expect(await screen.findByText('PR opened')).toBeInTheDocument()
    expect(init).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'https://github.com/acme/hivemind/pull/9' })
    ).toBeInTheDocument()
  })

  it('a zero-commit preview asks for confirmation before pushing directly', async () => {
    const { init } = stubArgus(
      vi.fn(async () => ({ ok: true as const, outcome: 'initialized' as const, prUrl: null })),
      vi.fn(async () => ({ noCommits: true, readme: '# Argus HiveMind\n', missing: ['README.md'] }))
    )
    render(<HivemindInitDialog onClose={vi.fn()} onDone={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Push initial commit' }))

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith({
        title: 'Push the initial commit?',
        message:
          'This repository has no commits yet, so there is nothing to open a pull request against — Argus will push directly to its default branch instead of proposing a change for review.',
        confirmLabel: 'Push'
      })
    )
    expect(await screen.findByText('Initial commit pushed')).toBeInTheDocument()
    expect(init).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /^https:\/\// })).not.toBeInTheDocument()
  })

  it('declining the confirm calls init() zero times', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    const { init } = stubArgus(
      undefined,
      vi.fn(async () => ({ noCommits: true, readme: '# Argus HiveMind\n', missing: ['README.md'] }))
    )
    render(<HivemindInitDialog onClose={vi.fn()} onDone={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Push initial commit' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(init).not.toHaveBeenCalled()
  })

  it('nothing missing disables the action button', async () => {
    stubArgus(undefined, vi.fn(async () => ({ noCommits: false, readme: '', missing: [] })))
    render(<HivemindInitDialog onClose={vi.fn()} onDone={vi.fn()} />)
    expect(
      await screen.findByText('The layout is already complete — nothing to add.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeDisabled()
  })

  it('a teammate-blocked failure links their PR and surfaces the error', async () => {
    stubArgus(
      vi.fn(async () => ({
        ok: false as const,
        error: 'A teammate already has an open pull request setting up the HiveMind layout.',
        blockedByPrUrl: 'https://github.com/acme/hivemind/pull/6'
      }))
    )
    render(<HivemindInitDialog onClose={vi.fn()} onDone={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open pull request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A teammate already has')
    expect(
      screen.getByRole('button', { name: 'https://github.com/acme/hivemind/pull/6' })
    ).toBeInTheDocument()
  })

  it('a plain failure keeps the dialog open with the error banner', async () => {
    stubArgus(vi.fn(async () => ({ ok: false as const, error: 'gh not authenticated' })))
    render(<HivemindInitDialog onClose={vi.fn()} onDone={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open pull request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('gh not authenticated')
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeInTheDocument()
  })

  it('Cancel calls onClose without calling init()', async () => {
    const { init } = stubArgus()
    const onClose = vi.fn()
    render(<HivemindInitDialog onClose={onClose} onDone={vi.fn()} />)
    await screen.findByText(/Adds:/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(init).not.toHaveBeenCalled()
  })
})
