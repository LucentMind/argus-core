// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { SharePushDialog } from '../SharePushDialog'

function stubArgus(
  push: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    ok: true as const,
    prUrl: 'https://pr/1',
    updated: false
  })),
  pushPreview: ReturnType<typeof vi.fn> = vi.fn(async () => 'PREVIEW BODY'),
  pushStatus: ReturnType<typeof vi.fn> = vi.fn(async () => ({ state: 'none' as const }))
): {
  push: ReturnType<typeof vi.fn>
  pushPreview: ReturnType<typeof vi.fn>
  pushStatus: ReturnType<typeof vi.fn>
} {
  ;(window as never as { argus: unknown }).argus = {
    hivemind: { pushPreview, push, pushStatus },
    openExternal: vi.fn()
  }
  return { push, pushPreview, pushStatus }
}

describe('SharePushDialog', () => {
  it('previews, pushes with the edited title, then shows the PR link', async () => {
    const { push } = stubArgus()
    render(<SharePushDialog kind="skill" name="my-skill" onClose={vi.fn()} />)
    expect(await screen.findByText('PREVIEW BODY')).toBeInTheDocument()

    const title = screen.getByLabelText('PR title')
    expect(title).toHaveValue('Add my-skill')
    fireEvent.change(title, { target: { value: 'Add my-skill v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))

    expect(await screen.findByText('PR opened')).toBeInTheDocument()
    expect(push).toHaveBeenCalledWith('skill', 'my-skill', 'Add my-skill v2')
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  it('a failed preview surfaces the error and Retry refetches it in place', async () => {
    const { pushPreview } = stubArgus(
      undefined,
      vi
        .fn()
        .mockRejectedValueOnce(new Error('preview exploded'))
        .mockResolvedValueOnce('PREVIEW BODY')
    )
    render(<SharePushDialog kind="skill" name="my-skill" onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('preview exploded')
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }))

    expect(await screen.findByText('PREVIEW BODY')).toBeInTheDocument()
    expect(pushPreview).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeEnabled()
  })

  it('surfaces a push error and stays open', async () => {
    stubArgus(vi.fn(async () => ({ ok: false as const, error: 'gh not authenticated' })))
    render(<SharePushDialog kind="reference" name="notes.md" onClose={vi.fn()} />)
    await screen.findByText('PREVIEW BODY')
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('gh not authenticated')
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeInTheDocument()
  })

  it('an already-open unchanged PR blocks the push and links the PR', async () => {
    const { push } = stubArgus(
      undefined,
      undefined,
      vi.fn(async () => ({ state: 'open-mine' as const, prUrl: 'https://pr/7', changed: false }))
    )
    render(<SharePushDialog kind="skill" name="my-skill" onClose={vi.fn()} />)
    expect(await screen.findByText('Already shared')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'https://pr/7' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pull request$/ })).not.toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('an already-open PR with local changes offers Update instead of Open', async () => {
    const { push } = stubArgus(
      vi.fn(async () => ({ ok: true as const, prUrl: 'https://pr/7', updated: true })),
      undefined,
      vi.fn(async () => ({ state: 'open-mine' as const, prUrl: 'https://pr/7', changed: true }))
    )
    render(<SharePushDialog kind="skill" name="my-skill" onClose={vi.fn()} />)
    await screen.findByText('PREVIEW BODY')
    const btn = screen.getByRole('button', { name: 'Update pull request' })
    fireEvent.click(btn)
    expect(await screen.findByText('PR updated')).toBeInTheDocument()
    expect(push).toHaveBeenCalledWith('skill', 'my-skill', 'Add my-skill')
  })

  it("a teammate's open PR blocks sharing entirely, with no override", async () => {
    const { push } = stubArgus(
      undefined,
      undefined,
      vi.fn(async () => ({
        state: 'open-teammate' as const,
        prUrl: 'https://pr/42',
        prAuthor: 'alex'
      }))
    )
    render(<SharePushDialog kind="reference" name="notes.md" onClose={vi.fn()} />)
    expect(await screen.findByText('Already open')).toBeInTheDocument()
    expect(screen.getByText(/alex already has this open/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pull request$/ })).not.toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('a failed status check degrades to the normal share flow with a warning', async () => {
    stubArgus(
      undefined,
      undefined,
      vi.fn(async () => ({ state: 'none' as const, warning: 'gh: not authenticated' }))
    )
    render(<SharePushDialog kind="skill" name="my-skill" onClose={vi.fn()} />)
    await screen.findByText('PREVIEW BODY')
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeEnabled()
    expect(screen.getByText(/could not check for an existing pull request/i)).toBeInTheDocument()
  })

  it('a preload with no pushStatus (older window) still shares normally', async () => {
    ;(window as never as { argus: unknown }).argus = {
      hivemind: {
        pushPreview: vi.fn(async () => 'PREVIEW BODY'),
        push: vi.fn(async () => ({ ok: true as const, prUrl: 'https://pr/1', updated: false }))
      },
      openExternal: vi.fn()
    }
    render(<SharePushDialog kind="skill" name="my-skill" onClose={vi.fn()} />)
    await screen.findByText('PREVIEW BODY')
    expect(screen.getByRole('button', { name: 'Open pull request' })).toBeEnabled()
  })
})
