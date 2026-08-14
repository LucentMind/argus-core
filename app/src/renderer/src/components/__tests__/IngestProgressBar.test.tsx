// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { IngestProgressBar } from '../IngestProgressBar'
import type { QueueProgressEvent } from '../../../../shared/evidenceProgress'

type QueueCb = (p: QueueProgressEvent) => void

let emit: QueueCb

beforeEach(() => {
  emit = () => {}
  ;(window as unknown as { argus: unknown }).argus = {
    evidence: {
      onQueueProgress: vi.fn((cb: QueueCb) => {
        emit = cb
        return () => {}
      })
    }
  }
})

const MB = 1024 * 1024

describe('IngestProgressBar', () => {
  it('renders nothing before any queue activity', () => {
    const { container } = render(<IngestProgressBar caseSlug="A-1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows file counts and megabytes while indexing', () => {
    render(<IngestProgressBar caseSlug="A-1" />)
    act(() =>
      emit({ slug: 'A-1', filesDone: 3, filesTotal: 7, bytesDone: 120 * MB, bytesTotal: 480 * MB })
    )
    expect(screen.getByText('3 of 7 files · 120 MB of 480 MB')).toBeInTheDocument()
  })

  it('sets the bar width from bytes, not file count', () => {
    render(<IngestProgressBar caseSlug="A-1" />)
    act(() =>
      emit({ slug: 'A-1', filesDone: 6, filesTotal: 7, bytesDone: 50 * MB, bytesTotal: 500 * MB })
    )
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '10')
  })

  it('disappears when the queue drains', () => {
    const { container } = render(<IngestProgressBar caseSlug="A-1" />)
    act(() =>
      emit({ slug: 'A-1', filesDone: 1, filesTotal: 2, bytesDone: 10 * MB, bytesTotal: 20 * MB })
    )
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    act(() => emit({ slug: 'A-1', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 }))
    expect(container).toBeEmptyDOMElement()
  })

  it('ignores another case queue', () => {
    const { container } = render(<IngestProgressBar caseSlug="A-1" />)
    act(() =>
      emit({ slug: 'B-2', filesDone: 1, filesTotal: 4, bytesDone: 1 * MB, bytesTotal: 4 * MB })
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('falls back to file counts when nothing is indexable (bytesTotal stays 0)', () => {
    render(<IngestProgressBar caseSlug="A-1" />)
    act(() => emit({ slug: 'A-1', filesDone: 2, filesTotal: 5, bytesDone: 0, bytesTotal: 0 }))
    expect(screen.getByText('2 of 5 files')).toBeInTheDocument()
    expect(screen.queryByText(/MB/)).not.toBeInTheDocument()
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '40')
  })
})
