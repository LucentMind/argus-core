// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseFiles } from '../CaseFiles'
import type { ArtifactTypeMeta, EvidenceRecord } from '../../../../shared/types'
import type { PanelDecl } from '../../../../shared/panels'

const evidenceFixture: EvidenceRecord[] = [
  {
    id: 1,
    caseId: 1,
    relPath: 'evidence/trace.binlog',
    sha256: 'x',
    artifactType: 'binlog',
    size: 2_200_000,
    origin: 'upload',
    meta: {},
    createdAt: '2026-03-14T09:32:00.000Z'
  },
  {
    id: 2,
    caseId: 1,
    relPath: 'evidence/notes.md',
    sha256: 'y',
    artifactType: 'text',
    size: 500,
    origin: 'upload',
    meta: {},
    createdAt: '2026-03-13T22:04:00.000Z'
  }
]

const artifactMetaFixture: ArtifactTypeMeta[] = [
  { type: 'binlog', displayName: 'Binary log', analyzeSkill: 'analyze-binlog', isText: false },
  { type: 'text', displayName: 'Text', analyzeSkill: null, isText: true },
  { type: 'unknown', displayName: 'Unknown', analyzeSkill: null, isText: false }
]

let parsingCb: (p: { slug: string; evidenceId: number; active: boolean }) => void

beforeEach(() => {
  window.argus = {
    files: {
      list: vi.fn(async () => []),
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
      list: vi.fn(async () => evidenceFixture),
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

  it('renders evidence rows with type badges and MB sizes', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    expect(await screen.findByText('trace.binlog')).toBeTruthy()
    expect(screen.getByText('binlog')).toBeTruthy()
    expect(screen.getByText('2.1 MB')).toBeTruthy()
    expect(screen.getByText('notes.md')).toBeTruthy()
  })

  it('type filter hides non-matching evidence', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    fireEvent.change(screen.getByLabelText('type-filter'), { target: { value: 'binlog' } })
    expect(screen.queryByText('notes.md')).toBeNull()
    expect(screen.getByText('trace.binlog')).toBeTruthy()
  })

  it('Analyze suggests the skill with the real relPath', async () => {
    const onSuggest = vi.fn()
    render(<CaseFiles caseSlug="NAV-1" onSuggest={onSuggest} onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getAllByRole('button', { name: 'Analyze' })[0])
    expect(onSuggest).toHaveBeenCalledWith('/analyze-binlog evidence/trace.binlog')
  })

  it('truncated title carries the full filename as a tooltip', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    const title = await screen.findByText('trace.binlog')
    expect(title.getAttribute('title')).toBe('trace.binlog')
  })

  it('shows size and a "D Mon, HH:MM" date in the meta row', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    const d = new Date('2026-03-14T09:32:00.000Z')
    const expected = `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}, ${String(
      d.getHours()
    ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it('delete is an icon-only button with no visible "Delete" text', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    const btn = await screen.findByRole('button', { name: 'Delete trace.binlog' })
    expect(btn.textContent?.trim()).toBe('')
  })

  it('shows a parsing indicator while extraction is active', async () => {
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    act(() => parsingCb({ slug: 'NAV-1', evidenceId: 1, active: true }))
    expect(screen.getByText('parsing…')).toBeTruthy()
    act(() => parsingCb({ slug: 'NAV-1', evidenceId: 1, active: false }))
    expect(screen.queryByText('parsing…')).toBeNull()
  })

  it('text evidence goes to onOpenFile; binaries to files.open; header button reveals', async () => {
    const onOpenFile = vi.fn()
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={onOpenFile} />)
    fireEvent.click(await screen.findByText('notes.md'))
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: 'evidence/notes.md' })
    )
    fireEvent.click(screen.getByText('trace.binlog'))
    await waitFor(() =>
      expect(window.argus.files.open).toHaveBeenCalledWith('NAV-1', 'evidence/trace.binlog')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open in file explorer' }))
    expect(window.argus.files.reveal).toHaveBeenCalledWith('NAV-1')
  })

  it('shows "No evidence yet." when the list rejects, without an unhandled rejection', async () => {
    window.argus.evidence.list = vi.fn(async () => {
      throw new Error('case dir gone')
    })
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await waitFor(() => expect(window.argus.evidence.list).toHaveBeenCalled())
    expect(screen.getByText('No evidence yet.')).toBeTruthy()
  })

  it('renders the derived chip for evidence with a derivedFrom parent', async () => {
    window.argus.evidence.list = vi.fn(async () => [
      ...evidenceFixture,
      {
        id: 3,
        caseId: 1,
        relPath: 'evidence/.derived/trace.binlog.txt',
        sha256: 'z',
        artifactType: 'text',
        size: 5,
        origin: 'upload',
        meta: { derivedFrom: 1 },
        createdAt: '2026-03-14T09:33:00.000Z'
      }
    ])
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    expect(await screen.findByText('trace.binlog.txt')).toBeTruthy()
    expect(screen.getByText('derived')).toBeTruthy()
  })

  it('Delete confirms with the derived count and calls evidence.delete', async () => {
    window.confirm = vi.fn(() => true)
    window.argus.evidence.list = vi.fn(async () => [
      ...evidenceFixture,
      {
        id: 3,
        caseId: 1,
        relPath: 'evidence/.derived/trace.binlog.txt',
        sha256: 'z',
        artifactType: 'text',
        size: 5,
        origin: 'upload',
        meta: { derivedFrom: 1 },
        createdAt: '2026-03-14T09:33:00.000Z'
      }
    ])
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
    await screen.findByText('notes.md')
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes.md' }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect((window.argus.evidence as { delete: unknown }).delete).not.toHaveBeenCalled()
  })

  it('shows an inline error and still reloads when evidence.delete rejects', async () => {
    window.confirm = vi.fn(() => true)
    window.argus.evidence.delete = vi.fn(async () => {
      throw new Error('evidence locked')
    })
    render(<CaseFiles caseSlug="NAV-1" onOpenFile={vi.fn()} />)
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete trace.binlog' }))
    expect(await screen.findByText('evidence locked')).toBeTruthy()
    // initial mount + the finally-block reload after the failed delete
    await waitFor(() => expect(window.argus.evidence.list).toHaveBeenCalledTimes(2))
  })
})

const openInFixture: EvidenceRecord[] = [
  {
    id: 7,
    caseId: 1,
    relPath: 'evidence/app.log',
    sha256: 'w',
    artifactType: 'logcat',
    size: 1024,
    origin: 'upload',
    meta: {},
    createdAt: '2026-03-14T09:32:00.000Z'
  }
]

const openInDecls: PanelDecl[] = [
  {
    packId: 'sample-pack',
    windowId: 'text-viewer',
    title: 'Text Viewer',
    handles: ['logcat'],
    kind: 'webPanel'
  }
]

describe('CaseFiles "Open in"', () => {
  beforeEach(() => {
    window.argus = {
      packs: { artifactMeta: vi.fn(async () => []) },
      files: {
        list: vi.fn(async () => []),
        open: vi.fn(),
        reveal: vi.fn(),
        onChanged: vi.fn(() => () => {})
      },
      evidence: {
        list: vi.fn(async () => openInFixture),
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
