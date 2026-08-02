// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseFiles } from '../CaseFiles'
import { confirm } from '../../lib/confirmStore'
import type { ArtifactTypeMeta, EvidenceRecord } from '../../../../shared/types'
import type { PanelDecl } from '../../../../shared/panels'

vi.mock('../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

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

// the props every render needs beyond caseSlug/label/mode, which each test sets explicitly
const requiredProps = { onOpenFile: vi.fn() }

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
      delete: vi.fn(async () => ({ deleted: [] })),
      scan: vi.fn(async () => ({ added: [], modified: [], missing: [], errors: [] }))
    },
    packs: {
      artifactMeta: vi.fn(async () => artifactMetaFixture)
    },
    pathForFile: vi.fn()
  } as never
})

describe('CaseFiles', () => {
  it('renders the section title itself, with the actions beside it', () => {
    render(
      <CaseFiles
        caseSlug="c1"
        label="Code review artifacts"
        mode="investigation"
        {...requiredProps}
      />
    )
    expect(screen.getByText('Code review artifacts')).toBeInTheDocument()
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rescan evidence folder' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open in file explorer' })).toBeInTheDocument()
  })

  it('renders as a section card, like the rail sections above it', async () => {
    const { container } = render(
      <CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />
    )
    await screen.findByText('Evidence')
    expect(container.querySelector('section.surface-card, section.glass-panel')).not.toBeNull()
  })

  it('drops the type filter', () => {
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)
    expect(screen.queryByLabelText('type-filter')).not.toBeInTheDocument()
  })

  it('keeps the header outside the scrolling file region', async () => {
    const { container } = render(
      <CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />
    )
    await screen.findByText('Evidence')
    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    expect(scroller!.contains(screen.getByText('Evidence'))).toBe(false)
  })

  it('reports the rescan result on the control, not as a list row', async () => {
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)
    await userEvent.click(screen.getByRole('button', { name: 'Rescan evidence folder' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rescan evidence folder' })).toHaveAttribute(
        'title',
        expect.stringContaining('no changes')
      )
    )
  })

  it('fetches artifact type meta once on mount', async () => {
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    await waitFor(() => expect(window.argus.packs.artifactMeta).toHaveBeenCalledTimes(1))
  })

  it('renders evidence rows with type badges and MB sizes', async () => {
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    expect(await screen.findByText('trace.binlog')).toBeTruthy()
    expect(screen.getByText('binlog')).toBeTruthy()
    expect(screen.getByText('2.1 MB')).toBeTruthy()
    expect(screen.getByText('notes.md')).toBeTruthy()
  })

  it('Analyze suggests the skill with the real relPath', async () => {
    const onSuggest = vi.fn()
    render(
      <CaseFiles
        caseSlug="NAV-1"
        label="Evidence"
        mode="investigation"
        onSuggest={onSuggest}
        onOpenFile={vi.fn()}
      />
    )
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getAllByRole('button', { name: 'Analyze' })[0])
    expect(onSuggest).toHaveBeenCalledWith('/analyze-binlog evidence/trace.binlog')
  })

  it('truncated title carries the full filename as a tooltip', async () => {
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    const title = await screen.findByText('trace.binlog')
    expect(title.getAttribute('title')).toBe('trace.binlog')
  })

  it('shows size and a "D Mon, HH:MM" date in the meta row', async () => {
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    await screen.findByText('trace.binlog')
    const d = new Date('2026-03-14T09:32:00.000Z')
    const expected = `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}, ${String(
      d.getHours()
    ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(screen.getByText(expected)).toBeTruthy()
  })

  it('delete is an icon-only button with no visible "Delete" text', async () => {
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    const btn = await screen.findByRole('button', { name: 'Delete trace.binlog' })
    expect(btn.textContent?.trim()).toBe('')
  })

  it('shows a parsing indicator while extraction is active', async () => {
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    await screen.findByText('trace.binlog')
    act(() => parsingCb({ slug: 'NAV-1', evidenceId: 1, active: true }))
    expect(screen.getByText('parsing…')).toBeTruthy()
    act(() => parsingCb({ slug: 'NAV-1', evidenceId: 1, active: false }))
    expect(screen.queryByText('parsing…')).toBeNull()
  })

  it('text evidence goes to onOpenFile; binaries reveal; header button reveals', async () => {
    const onOpenFile = vi.fn()
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={onOpenFile} />
    )
    fireEvent.click(await screen.findByText('notes.md'))
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relPath: 'evidence/notes.md',
        // evidence identity must travel with the node so App can route large
        // text evidence to the indexed TextViewer instead of FileViewer
        evidence: expect.objectContaining({ id: 2 })
      })
    )
    // a detected binary (parsed into derived text) must not hand the raw file to
    // whatever program owns its extension — reveal it in the explorer instead
    fireEvent.click(screen.getByText('trace.binlog'))
    await waitFor(() =>
      expect(window.argus.files.reveal).toHaveBeenCalledWith('NAV-1', 'evidence/trace.binlog')
    )
    expect(window.argus.files.open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open in file explorer' }))
    expect(window.argus.files.reveal).toHaveBeenCalledWith('NAV-1')
  })

  it('archives reveal in the explorer; screenshots and videos open externally', async () => {
    window.argus.evidence.list = vi.fn(async () => [
      { ...evidenceFixture[0], id: 10, relPath: 'evidence/logs.zip', artifactType: 'archive' },
      { ...evidenceFixture[0], id: 11, relPath: 'evidence/logs.dlt', artifactType: 'dlt_log' },
      { ...evidenceFixture[0], id: 12, relPath: 'evidence/shot.png', artifactType: 'screenshot' },
      { ...evidenceFixture[0], id: 13, relPath: 'evidence/repro.mp4', artifactType: 'unknown' },
      // magic-byte detection, no usable extension — still a viewable image
      {
        ...evidenceFixture[0],
        id: 14,
        relPath: 'evidence/Screenshot_042',
        artifactType: 'screenshot'
      }
    ])
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )

    fireEvent.click(await screen.findByText('logs.zip'))
    fireEvent.click(screen.getByText('logs.dlt'))
    await waitFor(() => expect(window.argus.files.reveal).toHaveBeenCalledTimes(2))
    expect(window.argus.files.reveal).toHaveBeenCalledWith('NAV-1', 'evidence/logs.zip')
    expect(window.argus.files.reveal).toHaveBeenCalledWith('NAV-1', 'evidence/logs.dlt')
    expect(window.argus.files.open).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('shot.png'))
    fireEvent.click(screen.getByText('repro.mp4'))
    fireEvent.click(screen.getByText('Screenshot_042'))
    await waitFor(() => expect(window.argus.files.open).toHaveBeenCalledTimes(3))
    expect(window.argus.files.open).toHaveBeenCalledWith('NAV-1', 'evidence/shot.png')
    expect(window.argus.files.open).toHaveBeenCalledWith('NAV-1', 'evidence/repro.mp4')
    expect(window.argus.files.open).toHaveBeenCalledWith('NAV-1', 'evidence/Screenshot_042')
    expect(window.argus.files.reveal).toHaveBeenCalledTimes(2)
  })

  it('a pack-claimed type reveals even with a media extension', async () => {
    // Same question the auto-unzip gate asks: did a pack detector claim this
    // file? If so it is a domain artifact with its own extractor — reveal it,
    // never hand it to the program that owns the extension.
    window.argus.evidence.list = vi.fn(async () => [
      { ...evidenceFixture[0], id: 20, relPath: 'evidence/drive.mp4', artifactType: 'video_trace' },
      { ...evidenceFixture[0], id: 21, relPath: 'evidence/frame.png', artifactType: 'hmi_dump' }
    ])
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    fireEvent.click(await screen.findByText('drive.mp4'))
    fireEvent.click(screen.getByText('frame.png'))
    await waitFor(() => expect(window.argus.files.reveal).toHaveBeenCalledTimes(2))
    expect(window.argus.files.open).not.toHaveBeenCalled()
  })

  it('shows "No evidence yet." when the list rejects, without an unhandled rejection', async () => {
    window.argus.evidence.list = vi.fn(async () => {
      throw new Error('case dir gone')
    })
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    await waitFor(() => expect(window.argus.evidence.list).toHaveBeenCalled())
    expect(screen.getByText('No evidence yet.')).toBeTruthy()
  })

  it('caps a long artifact type badge at 2 lines instead of wrapping indefinitely', async () => {
    window.argus.evidence.list = vi.fn(async () => [
      {
        ...evidenceFixture[0],
        id: 4,
        relPath: 'evidence/weird.pack',
        artifactType: 'a-very-long-artifact-type-name-indeed',
        createdAt: '2026-03-14T09:34:00.000Z'
      }
    ])
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    const badge = await screen.findByText('a-very-long-artifact-type-name-indeed')
    expect(badge.classList.contains('line-clamp-2')).toBe(true)
  })

  it('renders the derived chip for evidence with a derivedFrom parent', async () => {
    window.argus.evidence.list = vi.fn(async (): Promise<EvidenceRecord[]> => [
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
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    expect(await screen.findByText('trace.binlog.txt')).toBeTruthy()
    expect(screen.getByText('derived')).toBeTruthy()
  })

  it('Delete confirms with the derived count and calls evidence.delete', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    window.argus.evidence.list = vi.fn(async (): Promise<EvidenceRecord[]> => [
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
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete trace.binlog' }))
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Delete "trace.binlog" and 1 derived file?' })
      )
    )
    await waitFor(() =>
      expect((window.argus.evidence as { delete: unknown }).delete).toHaveBeenCalledWith('NAV-1', 1)
    )
  })

  it('cancelling the confirm deletes nothing', async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    await screen.findByText('notes.md')
    fireEvent.click(screen.getByRole('button', { name: 'Delete notes.md' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect((window.argus.evidence as { delete: unknown }).delete).not.toHaveBeenCalled()
  })

  it('shows an inline error and still reloads when evidence.delete rejects', async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    window.argus.evidence.delete = vi.fn(async () => {
      throw new Error('evidence locked')
    })
    render(
      <CaseFiles caseSlug="NAV-1" label="Evidence" mode="investigation" onOpenFile={vi.fn()} />
    )
    await screen.findByText('trace.binlog')
    fireEvent.click(screen.getByRole('button', { name: 'Delete trace.binlog' }))
    expect(await screen.findByText('evidence locked')).toBeTruthy()
    // initial mount + the finally-block reload after the failed delete
    await waitFor(() => expect(window.argus.evidence.list).toHaveBeenCalledTimes(2))
  })

  it('Refresh scans and shows the summary in the header, not a list row or paragraph', async () => {
    window.argus.evidence.scan = vi.fn(async () => ({
      added: ['evidence/a.txt', 'evidence/b.txt'],
      modified: ['evidence/c.txt'],
      missing: [],
      errors: []
    }))
    render(<CaseFiles caseSlug="C1" label="Evidence" mode="investigation" onOpenFile={() => {}} />)
    const rescanBtn = screen.getByRole('button', { name: /rescan evidence folder/i })
    await userEvent.click(rescanBtn)
    expect(window.argus.evidence.scan).toHaveBeenCalledWith('C1', 'investigation')
    await waitFor(() =>
      expect(rescanBtn).toHaveAttribute('title', expect.stringContaining('2 added · 1 updated'))
    )
    // visible in the header row, not just on the tooltip
    const note = screen.getByText('2 added · 1 updated')
    expect(note).toBeInTheDocument()
    expect(note.tagName).not.toBe('P')
    // not the old paragraph-above-the-list form, and not a list row
    expect(note.closest('li')).toBeNull()
    expect(note.closest('ul')).toBeNull()
  })

  it('files.onChanged for this case lights the staleness dot; scanning clears it', async () => {
    let onFiles: ((slug: string) => void) | null = null
    window.argus.files.onChanged = vi.fn((cb) => {
      onFiles = cb
      return () => {}
    })
    render(<CaseFiles caseSlug="C1" label="Evidence" mode="investigation" onOpenFile={() => {}} />)
    await waitFor(() => expect(onFiles).not.toBeNull())
    act(() => onFiles!('OTHER'))
    expect(screen.queryByTestId('files-stale-dot')).toBeNull()
    act(() => onFiles!('C1'))
    expect(screen.getByTestId('files-stale-dot')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /rescan evidence folder/i }))
    await waitFor(() => expect(screen.queryByTestId('files-stale-dot')).toBeNull())
  })

  it('rows with meta.missing render a missing badge', async () => {
    window.argus.evidence.list = vi.fn(async (): Promise<EvidenceRecord[]> => [
      {
        id: 1,
        caseId: 1,
        relPath: 'evidence/gone.txt',
        sha256: 'x',
        artifactType: 'text',
        size: 3,
        origin: 'scan',
        meta: { missing: true },
        createdAt: '2026-07-17T00:00:00Z'
      }
    ])
    render(<CaseFiles caseSlug="C1" label="Evidence" mode="investigation" onOpenFile={() => {}} />)
    await screen.findByText('missing')
  })

  it('lists the active mode and ingests a drop into it', async () => {
    render(
      <CaseFiles caseSlug="c1" label="Code review artifacts" mode="review" {...requiredProps} />
    )
    await waitFor(() => expect(window.argus.evidence.list).toHaveBeenCalledWith('c1', 'review'))

    fireEvent.click(screen.getByRole('button', { name: /rescan|refresh/i }))
    await waitFor(() => expect(window.argus.evidence.scan).toHaveBeenCalledWith('c1', 'review'))
  })

  it('lists investigation by default', async () => {
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)
    await waitFor(() =>
      expect(window.argus.evidence.list).toHaveBeenCalledWith('c1', 'investigation')
    )
  })

  it('switching modes refetches the list for the new mode', async () => {
    const { rerender } = render(
      <CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />
    )
    await waitFor(() =>
      expect(window.argus.evidence.list).toHaveBeenCalledWith('c1', 'investigation')
    )
    rerender(
      <CaseFiles caseSlug="c1" label="Code review artifacts" mode="review" {...requiredProps} />
    )
    await waitFor(() => expect(window.argus.evidence.list).toHaveBeenCalledWith('c1', 'review'))
  })

  it('does not claim the case is empty while the list is still loading', async () => {
    let release: (rows: EvidenceRecord[]) => void = () => {}
    window.argus.evidence.list = vi.fn(
      () =>
        new Promise<EvidenceRecord[]>((res) => {
          release = res
        })
    )
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)

    // in flight: the definitive empty state must not be on screen
    expect(screen.queryByText('No evidence yet.')).toBeNull()

    await act(async () => {
      release([])
    })
    expect(screen.getByText('No evidence yet.')).toBeInTheDocument()
  })

  it('keeps the last-loaded rows on screen when a reload rejects, instead of clearing to empty', async () => {
    let onEvidence: ((slug: string) => void) | null = null
    window.argus.evidence.onChanged = vi.fn((cb) => {
      onEvidence = cb
      return () => {}
    })
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)
    await screen.findByText('trace.binlog')
    expect(screen.queryByText('No evidence yet.')).toBeNull()

    // a transient IPC failure on the next reload must not wipe what is already on screen
    window.argus.evidence.list = vi.fn(async () => {
      throw new Error('IPC down')
    })
    await act(async () => {
      onEvidence!('c1')
    })
    await waitFor(() => expect(window.argus.evidence.list).toHaveBeenCalled())

    expect(screen.getByText('trace.binlog')).toBeInTheDocument()
    expect(screen.getByText('notes.md')).toBeInTheDocument()
    expect(screen.queryByText('No evidence yet.')).toBeNull()
  })

  it('shows a pending row carrying the real filename while a drop ingests', async () => {
    let release: () => void = () => {}
    window.argus.evidence.ingest = vi.fn(
      () =>
        new Promise<EvidenceRecord[]>((res) => {
          release = () => res([])
        })
    )
    window.argus.pathForFile = vi.fn(() => 'C:\\logs\\huge.binlog')
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)
    await screen.findByText('trace.binlog')

    const file = new File(['x'], 'huge.binlog')
    fireEvent.drop(screen.getByText('drop files to add evidence').parentElement!, {
      dataTransfer: { files: [file] }
    })

    // present BEFORE the ingest resolves — this is the whole point
    expect(await screen.findByText('huge.binlog')).toBeInTheDocument()

    await act(async () => {
      release()
    })
    await waitFor(() => {
      expect(screen.queryByTestId('pending-evidence-huge.binlog')).toBeNull()
    })
  })

  // Regression coverage: ReposSection.link resolves `reload()` BEFORE `pending.resolve()` for
  // exactly this reason. handleDrop used to do it the other way — `pending.resolve(ids)` then
  // `await reload()` — so on a case with no evidence, the moment the ingest resolves there is a
  // real window where the pending row is gone (resolved) but the reloaded rows have not landed
  // yet, and `loaded && visible.length === 0 && pending.items.length === 0` is briefly all true:
  // "No evidence yet." paints on a case that just received a file.
  it('never shows "No evidence yet." between a drop resolving and the reload finishing', async () => {
    let listCalls = 0
    let releaseReloadList: ((rows: EvidenceRecord[]) => void) | null = null
    window.argus.evidence.list = vi.fn(() => {
      listCalls += 1
      // call 1: initial mount, case starts with no evidence. call 2: the reload() inside
      // handleDrop, held open so the window between ingest resolving and reload finishing
      // is observable.
      if (listCalls === 1) return Promise.resolve([])
      return new Promise<EvidenceRecord[]>((res) => {
        releaseReloadList = res
      })
    })
    let releaseIngest: (() => void) | null = null
    window.argus.evidence.ingest = vi.fn(
      () =>
        new Promise<EvidenceRecord[]>((res) => {
          releaseIngest = () => res([])
        })
    )
    window.argus.pathForFile = vi.fn(() => 'C:\\logs\\new.txt')
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)
    await screen.findByText('No evidence yet.')

    const file = new File(['x'], 'new.txt')
    fireEvent.drop(screen.getByText('drop files to add evidence').parentElement!, {
      dataTransfer: { files: [file] }
    })
    await screen.findByText('new.txt') // the pending row is up

    // resolve the ingest — the exact moment the wrong order lets "No evidence yet." flash back
    await act(async () => {
      releaseIngest!()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('No evidence yet.')).toBeNull()

    await act(async () => {
      releaseReloadList!([])
    })
  })

  it('keeps a failed drop on screen as an error row', async () => {
    window.argus.evidence.ingest = vi.fn(() => Promise.reject(new Error('EACCES: locked')))
    window.argus.pathForFile = vi.fn(() => 'C:\\logs\\locked.binlog')
    render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)
    await screen.findByText('trace.binlog')

    const file = new File(['x'], 'locked.binlog')
    fireEvent.drop(screen.getByText('drop files to add evidence').parentElement!, {
      dataTransfer: { files: [file] }
    })

    expect(await screen.findByTitle('EACCES: locked')).toBeInTheDocument()
    expect(screen.getByText('locked.binlog')).toBeInTheDocument()
  })

  it('shows a failed drop immediately even while the evidence list is still loading', async () => {
    vi.useFakeTimers()
    try {
      let releaseList: (rows: EvidenceRecord[]) => void = () => {}
      // the list never resolves inside this test, so `loaded` stays false and
      // usePendingDisplay's skeleton stays up past its 150ms threshold — the
      // exact window in which the finding's error row used to be invisible
      window.argus.evidence.list = vi.fn(
        () =>
          new Promise<EvidenceRecord[]>((res) => {
            releaseList = res
          })
      )
      window.argus.evidence.ingest = vi.fn(() => Promise.reject(new Error('EACCES: locked')))
      window.argus.pathForFile = vi.fn(() => 'C:\\logs\\locked.binlog')

      render(<CaseFiles caseSlug="c1" label="Evidence" mode="investigation" {...requiredProps} />)

      await act(async () => {
        vi.advanceTimersByTime(150)
      })
      // still loading: the skeleton is on screen, not the loaded rows
      expect(screen.getByTestId('skeleton-rows')).toBeInTheDocument()

      const file = new File(['x'], 'locked.binlog')
      await act(async () => {
        fireEvent.drop(screen.getByText('drop files to add evidence').parentElement!, {
          dataTransfer: { files: [file] }
        })
      })

      // the error row must appear now, not after the skeleton clears
      expect(screen.getByTitle('EACCES: locked')).toBeInTheDocument()
      expect(screen.getByText('locked.binlog')).toBeInTheDocument()

      await act(async () => {
        releaseList([])
      })
    } finally {
      vi.useRealTimers()
    }
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
        label="Evidence"
        mode="investigation"
        onOpenFile={vi.fn()}
        panelDecls={openInDecls}
        onOpenInPanel={onOpenInPanel}
      />
    )
    const btn = await screen.findByRole('button', { name: /Open in Text Viewer/i })
    fireEvent.click(btn)
    await waitFor(() => expect(onOpenInPanel).toHaveBeenCalledWith(7, 'sample-pack', 'text-viewer'))
  })

  it('routes oversized text evidence to the built-in viewer instead of a panel', async () => {
    const onOpenInPanel = vi.fn()
    const onOpenFile = vi.fn()
    window.argus.evidence.list = vi.fn(async () => [
      ...openInFixture,
      {
        id: 8,
        caseId: 1,
        relPath: 'evidence/huge.log',
        sha256: 'v',
        artifactType: 'logcat',
        size: 5 * 1024 * 1024,
        origin: 'upload',
        meta: {},
        createdAt: '2026-03-14T09:32:00.000Z'
      }
    ]) as never
    render(
      <CaseFiles
        caseSlug="CASE-1"
        label="Evidence"
        mode="investigation"
        onOpenFile={onOpenFile}
        panelDecls={openInDecls}
        onOpenInPanel={onOpenInPanel}
      />
    )
    const label = await screen.findByText('huge.log')
    const row = label.closest('li') as HTMLElement
    // a panel would whole-read the file — the pack button is replaced by the
    // size-routed built-in viewer button (same routing as the name click)
    expect(within(row).queryByRole('button', { name: /Open in Text Viewer/i })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Open in viewer' }))
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relPath: 'evidence/huge.log',
        evidence: expect.objectContaining({ id: 8 })
      })
    )
    expect(onOpenInPanel).not.toHaveBeenCalled()
    // the small row of the same type keeps its pack button
    const smallRow = screen.getByText('app.log').closest('li') as HTMLElement
    expect(
      within(smallRow).getByRole('button', { name: /Open in Text Viewer/i })
    ).toBeInTheDocument()
  })

  it('shows no Open-in control for an unhandled type', async () => {
    render(
      <CaseFiles
        caseSlug="CASE-1"
        label="Evidence"
        mode="investigation"
        onOpenFile={vi.fn()}
        panelDecls={[]}
        onOpenInPanel={vi.fn()}
      />
    )
    const label = await screen.findByText('app.log')
    // scoped to the evidence row: the header's unrelated "Open in file explorer"
    // button also matches a bare /Open in/i name, so a page-wide query would be a false negative-guard
    const row = label.closest('li') as HTMLElement
    expect(within(row).queryByRole('button', { name: /Open in/i })).toBeNull()
  })
})
