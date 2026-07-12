// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseFiles } from '../CaseFiles'
import type { ArtifactTypeMeta, FileNode } from '../../../../shared/types'
import type { PanelDecl } from '../../../../shared/panels'

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

const artifactMetaFixture: ArtifactTypeMeta[] = [
  { type: 'binlog', displayName: 'Binary log', analyzeSkill: 'analyze-binlog', isText: false },
  { type: 'applog', displayName: 'App log', analyzeSkill: 'analyze-applog', isText: true },
  { type: 'text', displayName: 'Text', analyzeSkill: null, isText: true },
  { type: 'unknown', displayName: 'Unknown', analyzeSkill: null, isText: false }
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
      }),
      list: vi.fn(async () => [
        { id: 1, meta: {} },
        { id: 2, meta: {} },
        { id: 3, meta: { derivedFrom: 1 } }
      ]),
      delete: vi.fn(async () => ({ deleted: [] }))
    },
    packs: {
      artifactMeta: vi.fn(async () => artifactMetaFixture)
    },
    pathForFile: vi.fn()
  } as never
})

describe('CaseFiles', () => {
  it('fetches artifact type meta once on mount', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await waitFor(() => expect(window.argus.packs.artifactMeta).toHaveBeenCalledTimes(1))
  })

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

  it('leaves the tree empty when the list rejects, without an unhandled rejection', async () => {
    window.argus.files.list = vi.fn(async () => {
      throw new Error('case dir gone')
    })
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await waitFor(() => expect(window.argus.files.list).toHaveBeenCalled())
    expect(screen.getByText('No files yet.')).toBeTruthy()
  })

  it('renders the derived chip for derived evidence nodes', async () => {
    window.argus.files.list = vi.fn(async () => [
      {
        name: 'trace.binlog.txt',
        relPath: 'evidence/.derived/trace.binlog.txt',
        kind: 'file',
        size: 5,
        evidence: { id: 3, artifactType: 'text', derived: true }
      }
    ]) as never
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    expect(await screen.findByText('trace.binlog.txt')).toBeTruthy()
    expect(screen.getByText('derived')).toBeTruthy()
  })

  it('Delete confirms with the derived count and calls evidence.delete', async () => {
    window.confirm = vi.fn(() => true)
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete trace.binlog' }))
    await waitFor(() =>
      expect(window.confirm).toHaveBeenCalledWith(
        'Delete "trace.binlog" and 1 derived file? This cannot be undone.'
      )
    )
    await waitFor(() =>
      expect((window.argus.evidence as { delete: unknown }).delete).toHaveBeenCalledWith('NAV-1', 1)
    )
  })

  it('cancelling the confirm deletes nothing', async () => {
    window.confirm = vi.fn(() => false)
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('log.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Delete log.txt' }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect((window.argus.evidence as { delete: unknown }).delete).not.toHaveBeenCalled()
  })

  it('plain files without evidence get no delete button', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('findings.md')
    expect(screen.queryByRole('button', { name: 'Delete findings.md' })).toBeNull()
  })

  it('shows an inline error and still reloads the tree when evidence.delete rejects', async () => {
    window.confirm = vi.fn(() => true)
    window.argus.evidence.delete = vi.fn(async () => {
      throw new Error('evidence locked')
    })
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete trace.binlog' }))
    expect(await screen.findByText('evidence locked')).toBeTruthy()
    // initial mount + the finally-block reload after the failed delete
    await waitFor(() => expect(window.argus.files.list).toHaveBeenCalledTimes(2))
  })
})

const openInTree: FileNode[] = [
  {
    name: 'app.log',
    relPath: 'evidence/app.log',
    kind: 'file',
    size: 1024,
    evidence: { id: 7, artifactType: 'logcat', derived: false }
  } as FileNode
]

const openInDecls: PanelDecl[] = [
  { packId: 'sample-pack', windowId: 'text-viewer', title: 'Text Viewer', handles: ['logcat'] }
]

describe('CaseFiles "Open in"', () => {
  beforeEach(() => {
    window.argus = {
      packs: { artifactMeta: vi.fn(async () => []) },
      files: {
        list: vi.fn(async () => openInTree),
        open: vi.fn(),
        reveal: vi.fn(),
        onChanged: vi.fn(() => () => {})
      },
      evidence: {
        list: vi.fn(async () => []),
        onChanged: vi.fn(() => () => {}),
        onParsing: vi.fn(() => () => {})
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  })

  it('offers an inline Open-in button for a handled evidence type', async () => {
    const onOpenInPanel = vi.fn()
    render(
      <CaseFiles
        caseSlug="CASE-1"
        onOpenFile={vi.fn()}
        panelDecls={openInDecls}
        onOpenInPanel={onOpenInPanel}
      />
    )
    const btn = await screen.findByRole('button', { name: /Open in Text Viewer/i })
    fireEvent.click(btn)
    await waitFor(() => expect(onOpenInPanel).toHaveBeenCalledWith(7, 'sample-pack', 'text-viewer'))
  })

  it('shows no Open-in control for an unhandled type', async () => {
    render(
      <CaseFiles caseSlug="CASE-1" onOpenFile={vi.fn()} panelDecls={[]} onOpenInPanel={vi.fn()} />
    )
    const label = await screen.findByText('app.log')
    // scoped to the evidence row: the header's unrelated "Open in file explorer"
    // button also matches a bare /Open in/i name, so a page-wide query would be a false negative-guard
    const row = label.closest('li') as HTMLElement
    expect(within(row).queryByRole('button', { name: /Open in/i })).toBeNull()
  })
})
