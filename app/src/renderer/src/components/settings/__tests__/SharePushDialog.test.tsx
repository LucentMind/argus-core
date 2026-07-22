// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { SharePushDialog } from '../SharePushDialog'

function stubArgus(
  push: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    ok: true as const,
    prUrl: 'https://pr/1'
  })),
  pushPreview: ReturnType<typeof vi.fn> = vi.fn(async () => 'PREVIEW BODY')
): {
  push: ReturnType<typeof vi.fn>
  pushPreview: ReturnType<typeof vi.fn>
} {
  ;(window as never as { argus: unknown }).argus = {
    hivemind: {
      pushPreview,
      push
    },
    openExternal: vi.fn()
  }
  return { push, pushPreview }
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
})
