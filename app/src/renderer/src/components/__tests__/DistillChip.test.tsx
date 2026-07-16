// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DistillChip } from '../DistillChip'
import type { DistillJobRow } from '../../../../shared/distill'

const job = (over: Partial<DistillJobRow>): DistillJobRow => ({
  id: 1,
  caseSlug: 'c1',
  state: 'done',
  error: null,
  itemCount: 3,
  createdAt: 't',
  finishedAt: 't',
  ...over
})

let retry: ReturnType<typeof vi.fn>
function setup(j: DistillJobRow | null): void {
  retry = vi.fn().mockResolvedValue(job({ state: 'queued' }))
  ;(window as unknown as { argus: unknown }).argus = {
    distill: {
      status: vi.fn().mockResolvedValue(j),
      retry,
      onChanged: vi.fn().mockReturnValue(() => undefined)
    }
  }
  render(<DistillChip slug="c1" />)
}

describe('DistillChip', () => {
  it('shows staged count when done', async () => {
    setup(job({ state: 'done', itemCount: 3 }))
    expect(await screen.findByText(/distilled · 3/)).toBeInTheDocument()
  })
  it('shows nothing-to-distill as first-class state', async () => {
    setup(job({ state: 'done', itemCount: 0 }))
    expect(await screen.findByText(/nothing to distill/i)).toBeInTheDocument()
  })
  it('failed state offers retry', async () => {
    setup(job({ state: 'failed', error: 'boom', itemCount: null }))
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    await waitFor(() => expect(retry).toHaveBeenCalledWith(1))
  })
  it('renders nothing when no job exists', async () => {
    setup(null)
    await waitFor(() =>
      expect(
        (window as never as { argus: { distill: { status: unknown } } }).argus.distill.status
      ).toHaveBeenCalled()
    )
    expect(screen.queryByText(/distill/i)).not.toBeInTheDocument()
  })
})
