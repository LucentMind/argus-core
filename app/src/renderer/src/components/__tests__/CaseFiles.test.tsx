// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseFiles } from '../CaseFiles'
import type { FileNode } from '../../../../shared/types'

const tree: FileNode[] = [
  {
    name: 'evidence',
    relPath: 'evidence',
    kind: 'dir',
    size: 0,
    children: [
      {
        name: 'trace.binlog',
        relPath: 'evidence/trace.binlog',
        kind: 'file',
        size: 2_200_000,
        evidence: { id: 1, artifactType: 'binlog', derived: false }
      },
      {
        name: 'log.txt',
        relPath: 'evidence/log.txt',
        kind: 'file',
        size: 500,
        evidence: { id: 2, artifactType: 'applog', derived: false }
      }
    ]
  },
  { name: 'findings.md', relPath: 'findings.md', kind: 'file', size: 120 }
]

let parsingCb: (p: { slug: string; evidenceId: number; active: boolean }) => void

beforeEach(() => {
  window.argus = {
    files: {
      list: vi.fn(async () => tree),
      read: vi.fn(),
      open: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => {})
    },
    evidence: {
      ingest: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
      onParsing: vi.fn((cb) => {
        parsingCb = cb
        return () => {}
      })
    },
    pathForFile: vi.fn()
  } as never
})

describe('CaseFiles', () => {
  it('renders the tree with evidence/ expanded, type badges and MB sizes', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    expect(await screen.findByText('trace.binlog')).toBeTruthy()
    expect(screen.getByText('binlog')).toBeTruthy()
    expect(screen.getByText('2.1 MB')).toBeTruthy()
    expect(screen.getByText('findings.md')).toBeTruthy()
  })

  it('collapses a directory on click', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    fireEvent.click(await screen.findByText('evidence'))
    expect(screen.queryByText('trace.binlog')).toBeNull()
  })

  it('type filter hides non-matching files but keeps the tree', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    fireEvent.change(screen.getByLabelText('type-filter'), { target: { value: 'binlog' } })
    expect(screen.queryByText('log.txt')).toBeNull()
    expect(screen.getByText('trace.binlog')).toBeTruthy()
  })

  it('Analyze suggests the skill with the real relPath', async () => {
    const onSuggest = vi.fn()
    render(<CaseFiles caseSlug="NAV-1" onSuggest={onSuggest} onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getAllByRole('button', { name: 'Analyze' })[0])
    expect(onSuggest).toHaveBeenCalledWith('/analyze-binlog evidence/trace.binlog')
  })

  it('shows a parsing indicator while extraction is active', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    act(() => parsingCb({ slug: 'NAV-1', evidenceId: 1, active: true }))
    expect(screen.getByText('parsing…')).toBeTruthy()
    act(() => parsingCb({ slug: 'NAV-1', evidenceId: 1, active: false }))
    expect(screen.queryByText('parsing…')).toBeNull()
  })

  it('text files go to onOpenFile; binaries to files.open; header button reveals', async () => {
    const onOpenFile = vi.fn()
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={onOpenFile} />)
    fireEvent.click(await screen.findByText('findings.md'))
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'findings.md' }))
    fireEvent.click(screen.getByText('trace.binlog'))
    await waitFor(() =>
      expect(window.argus.files.open).toHaveBeenCalledWith('NAV-1', 'evidence/trace.binlog')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open in file explorer' }))
    expect(window.argus.files.reveal).toHaveBeenCalledWith('NAV-1')
  })
})
