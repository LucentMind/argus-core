// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { CaseFiles } from '../CaseFiles'
import type { EvidencePhase } from '../../../../shared/evidenceProgress'

type ProgressCb = (p: {
  slug: string
  evidenceId: number
  phase: EvidencePhase
  fraction: number
}) => void

let emitProgress: ProgressCb

const record = {
  id: 7,
  caseId: 1,
  relPath: 'evidence/trace.txt',
  sha256: 'abc',
  artifactType: 'text',
  size: 1024,
  origin: 'upload',
  meta: { indexState: 'pending' },
  createdAt: '2026-08-14T00:00:00.000Z'
}

beforeEach(() => {
  emitProgress = () => {}
  ;(window as unknown as { argus: unknown }).argus = {
    evidence: {
      list: vi.fn(async () => [record]),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn((cb: ProgressCb) => {
        emitProgress = cb
        return () => {}
      }),
      onQueueProgress: vi.fn(() => () => {}),
      scan: vi.fn()
    },
    files: { onChanged: vi.fn(() => () => {}) },
    packs: { artifactMeta: vi.fn(async () => []) },
    pathForFile: vi.fn()
  }
})

describe('CaseFiles per-row progress', () => {
  it('shows a determinate indexing percentage', async () => {
    render(<CaseFiles caseSlug="P-1" mode="investigation" onOpenFile={vi.fn()} label="Evidence" />)
    expect(await screen.findByText('trace.txt')).toBeInTheDocument()

    act(() => emitProgress({ slug: 'P-1', evidenceId: 7, phase: 'indexing', fraction: 0.43 }))
    expect(screen.getByText('indexing 43%')).toBeInTheDocument()
  })

  it('shows parsing during extraction and clears on done', async () => {
    render(<CaseFiles caseSlug="P-1" mode="investigation" onOpenFile={vi.fn()} label="Evidence" />)
    await screen.findByText('trace.txt')

    act(() => emitProgress({ slug: 'P-1', evidenceId: 7, phase: 'extracting', fraction: 1 }))
    expect(screen.getByText('parsing…')).toBeInTheDocument()

    act(() => emitProgress({ slug: 'P-1', evidenceId: 7, phase: 'done', fraction: 1 }))
    expect(screen.queryByText('parsing…')).not.toBeInTheDocument()
    expect(screen.queryByText(/indexing/)).not.toBeInTheDocument()
  })

  it('leaves a persistent chip on an index error', async () => {
    const evidence = (
      window as unknown as {
        argus: { evidence: { onChanged: (cb: (slug: string) => void) => () => void } }
      }
    ).argus.evidence
    let emitChanged: ((slug: string) => void) | undefined
    evidence.onChanged = vi.fn((cb: (slug: string) => void) => {
      emitChanged = cb
      return () => {}
    })

    render(<CaseFiles caseSlug="P-1" mode="investigation" onOpenFile={vi.fn()} label="Evidence" />)
    await screen.findByText('trace.txt')

    act(() => emitProgress({ slug: 'P-1', evidenceId: 7, phase: 'error', fraction: 1 }))
    expect(screen.getByText('index failed')).toBeInTheDocument()

    // A reload triggered by an unrelated evidence:changed event (e.g. another file added)
    // must not clear the error chip -- only the row itself disappearing should. A regression
    // that reset the progress map on every reload would still pass the assertion above but
    // fail this one.
    act(() => emitChanged?.('P-1'))
    await screen.findByText('trace.txt')
    expect(screen.getByText('index failed')).toBeInTheDocument()
  })

  it('ignores events for a different case', async () => {
    render(<CaseFiles caseSlug="P-1" mode="investigation" onOpenFile={vi.fn()} label="Evidence" />)
    await screen.findByText('trace.txt')

    act(() => emitProgress({ slug: 'OTHER', evidenceId: 7, phase: 'indexing', fraction: 0.5 }))
    expect(screen.queryByText(/indexing/)).not.toBeInTheDocument()
  })
})
