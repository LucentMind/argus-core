// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { NewCaseDialog } from '../NewCaseDialog'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'
import type { JiraAttachmentProgress } from '../../../../shared/jira'
// The real validator, not a restated pattern — a copy here could drift from what
// createCase actually enforces (see Finding C2).
import { SLUG_RE } from '../../../../main/services/caseService'

const PREVIEW = {
  key: 'PROJ-7',
  summary: 'Route flickers',
  status: 'Open',
  priority: null,
  labels: ['nav'],
  reporter: 'Ada',
  created: 'c',
  updated: 'u',
  attachments: [
    {
      id: '10001',
      filename: 'trace.binlog',
      size: 2048,
      mimeType: 'application/octet-stream',
      createdAt: 'x'
    },
    { id: '10002', filename: 'log.txt', size: 100, mimeType: 'text/plain', createdAt: 'x' }
  ],
  cloneLinks: []
}

let progressCb: ((p: JiraAttachmentProgress) => void) | null
let jira: {
  preview: ReturnType<typeof vi.fn>
  createCase: ReturnType<typeof vi.fn>
  ingestAttachments: ReturnType<typeof vi.fn>
  onAttachmentProgress: ReturnType<typeof vi.fn>
  setAttachmentSelection: ReturnType<typeof vi.fn>
}

const noop = { onClose: vi.fn(), onCreateBlank: vi.fn(async () => {}), onOpenCase: vi.fn() }

beforeEach(() => {
  progressCb = null
  jira = {
    preview: vi.fn(async () => ({ ok: true, value: PREVIEW })),
    createCase: vi.fn(async () => ({ ok: true, value: { slug: 'PROJ-7' } })),
    ingestAttachments: vi.fn(async () => ({ ok: true, value: [] })),
    onAttachmentProgress: vi.fn((cb: (p: JiraAttachmentProgress) => void) => {
      progressCb = cb
      return () => {}
    }),
    setAttachmentSelection: vi.fn(async () => ({ ok: true, value: {} }))
  }
  window.argus = { jira } as never
  // A stale call from an earlier test would let a same-shaped toHaveBeenCalledWith
  // assertion pass without this test's own action actually firing it.
  noop.onClose.mockClear()
  noop.onCreateBlank.mockClear()
  noop.onOpenCase.mockClear()
})

afterEach(() => __resetEscapeLayersForTest())

describe('NewCaseDialog', () => {
  it('Escape in a draft field clears it, then blurs, then closes the dialog', async () => {
    const onClose = vi.fn()
    render(<NewCaseDialog {...noop} onClose={onClose} />)
    const slug = screen.getByPlaceholderText('slug (e.g. NAVAPI-123)')
    await userEvent.type(slug, 'ABC-1')
    // stage 1: non-empty field — Escape clears it, dialog stays open
    await userEvent.keyboard('{Escape}')
    expect(slug).toHaveValue('')
    expect(onClose).not.toHaveBeenCalled()
    // stage 2: now-empty field — Escape blurs it, dialog still stays open
    await userEvent.keyboard('{Escape}')
    expect(slug).not.toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
    // stage 3: focus is back on the shell — Escape reaches the overlay and closes it
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('fetches a ticket and prefills slug + title from key + summary', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    expect(await screen.findByDisplayValue('PROJ-7')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Route flickers')).toBeInTheDocument()
    // attachments pre-checked — the toggle is a button, so these are the two files
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    for (const b of boxes) expect(b).toBeChecked()
  })

  it('toggle-all clears every attachment, then re-selects them all', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')

    fireEvent.click(screen.getByRole('button', { name: /deselect all/i }))
    expect(screen.getByRole('checkbox', { name: /trace\.binlog/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /log\.txt/ })).not.toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /select all/i }))
    expect(screen.getByRole('checkbox', { name: /trace\.binlog/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /log\.txt/ })).toBeChecked()

    // partial selection still offers the completing action, not the clearing one
    fireEvent.click(screen.getByRole('checkbox', { name: /log\.txt/ }))
    expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument()
  })

  it('lists attachments grouped by type, not in the order Jira returned them', async () => {
    jira.preview.mockResolvedValueOnce({
      ok: true,
      value: {
        ...PREVIEW,
        attachments: [
          { id: '1', filename: 'b.txt', size: 1, mimeType: 'text/plain', createdAt: 'x' },
          { id: '2', filename: 'dump.bin', size: 1, mimeType: 'application/octet-stream' },
          { id: '3', filename: 'a.txt', size: 1, mimeType: 'text/plain', createdAt: 'x' }
        ]
      }
    })
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    // first span in each row is the filename cell
    const names = screen
      .getAllByRole('checkbox')
      .map((b) => b.closest('label')?.querySelector('span')?.textContent ?? '')
    expect(names).toEqual(['dump.bin', 'a.txt', 'b.txt'])
  })

  it('deselecting all then creating ingests nothing and persists every id', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    fireEvent.click(screen.getByRole('button', { name: /deselect all/i }))
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))
    await waitFor(() =>
      expect(jira.setAttachmentSelection).toHaveBeenCalledWith('PROJ-7', ['10001', '10002'])
    )
    expect(jira.ingestAttachments).not.toHaveBeenCalled()
  })

  it('fetches a ticket from a pasted full Jira link', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), {
      target: { value: 'https://foo.atlassian.net/browse/PROJ-7' }
    })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await waitFor(() => expect(jira.preview).toHaveBeenCalledWith('PROJ-7'))
  })

  it('creates a blank case from a pasted full Jira link in the optional jira field', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/^slug/i), { target: { value: 'adhoc-1' } })
    fireEvent.change(screen.getByPlaceholderText(/^title/i), { target: { value: 'Ad hoc' } })
    fireEvent.change(screen.getByPlaceholderText(/jira key/i), {
      target: { value: 'https://foo.atlassian.net/browse/PROJ-7' }
    })
    fireEvent.click(screen.getByRole('button', { name: /create blank case/i }))
    await waitFor(() =>
      expect(noop.onCreateBlank).toHaveBeenCalledWith({
        slug: 'adhoc-1',
        title: 'Ad hoc',
        jiraKey: 'PROJ-7'
      })
    )
  })

  it('not-configured errors point at the Connectors page; blank path stays available', async () => {
    jira.preview.mockResolvedValueOnce({
      ok: false,
      code: 'not-configured',
      message: 'No Atlassian connector configured'
    })
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Settings → Connectors/i)
    expect(screen.getByRole('button', { name: /create blank case/i })).toBeInTheDocument()
  })

  it('a failed fetch keeps the typed key in the entry field for retry', async () => {
    jira.preview.mockResolvedValueOnce({
      ok: false,
      code: 'network',
      message: 'fetch failed'
    })
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByRole('alert')
    expect(screen.getByPlaceholderText(/PROJ-1234/i)).toHaveDisplayValue('PROJ-7')
    expect(screen.getByRole('button', { name: /fetch ticket/i })).toBeEnabled()
  })

  it('creates the case, ingests checked attachments with per-file progress, offers Start triage', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    fireEvent.click(screen.getByRole('checkbox', { name: /log\.txt/ })) // uncheck log.txt
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))
    await waitFor(() =>
      expect(jira.ingestAttachments).toHaveBeenCalledWith('PROJ-7', 'PROJ-7', [
        PREVIEW.attachments[0]
      ])
    )
    // The subscription happens in a passive effect after the ingest step commits,
    // which can land later than the ingestAttachments call under load — wait for
    // it explicitly before emitting progress events.
    await waitFor(() => expect(progressCb).not.toBeNull())
    act(() =>
      progressCb!({
        caseSlug: 'PROJ-7',
        attachmentId: '10001',
        filename: 'trace.binlog',
        status: 'downloading'
      })
    )
    act(() =>
      progressCb!({
        caseSlug: 'PROJ-7',
        attachmentId: '10001',
        filename: 'trace.binlog',
        status: 'done',
        evidenceId: 1
      })
    )
    expect(await screen.findByText(/done/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /start triage/i }))
    expect(noop.onOpenCase).toHaveBeenCalledWith('PROJ-7')
  })

  it('persists deselected attachment ids after case creation', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    fireEvent.click(screen.getByRole('checkbox', { name: /log\.txt/ })) // uncheck log.txt
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))
    await waitFor(() =>
      expect(jira.setAttachmentSelection).toHaveBeenCalledWith('PROJ-7', ['10002'])
    )
  })

  it('a failed file shows Retry and re-calls ingestAttachments for just that file', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))
    await waitFor(() => expect(jira.ingestAttachments).toHaveBeenCalled())
    await waitFor(() => expect(progressCb).not.toBeNull())
    act(() =>
      progressCb!({
        caseSlug: 'PROJ-7',
        attachmentId: '10001',
        filename: 'trace.binlog',
        status: 'error',
        error: 'boom'
      })
    )
    const retry = await screen.findByRole('button', { name: /retry/i })
    fireEvent.click(retry)
    await waitFor(() =>
      expect(jira.ingestAttachments).toHaveBeenLastCalledWith('PROJ-7', 'PROJ-7', [
        PREVIEW.attachments[0]
      ])
    )
  })

  it('blank path creates via onCreateBlank with the existing NewCaseInput shape', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/^slug/i), { target: { value: 'adhoc-1' } })
    fireEvent.change(screen.getByPlaceholderText(/^title/i), { target: { value: 'Ad hoc' } })
    fireEvent.click(screen.getByRole('button', { name: /create blank case/i }))
    await waitFor(() =>
      expect(noop.onCreateBlank).toHaveBeenCalledWith({
        slug: 'adhoc-1',
        title: 'Ad hoc',
        jiraKey: undefined
      })
    )
  })

  it('a rejected blank-path create surfaces in the error alert and keeps the dialog open', async () => {
    const onClose = vi.fn()
    const onCreateBlank = vi.fn(async () => {
      throw new Error('slug already exists')
    })
    render(<NewCaseDialog onClose={onClose} onCreateBlank={onCreateBlank} onOpenCase={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/^slug/i), { target: { value: 'adhoc-1' } })
    fireEvent.change(screen.getByPlaceholderText(/^title/i), { target: { value: 'Ad hoc' } })
    fireEvent.click(screen.getByRole('button', { name: /create blank case/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/slug already exists/i)
    expect(onClose).not.toHaveBeenCalled()
    // form is usable again after the failure
    expect(screen.getByRole('button', { name: /create blank case/i })).toBeEnabled()
  })

  it('renders no clone-source section when the ticket has no clone links', async () => {
    jira.preview = vi.fn(async () => ({ ok: true, value: { ...PREVIEW, cloneLinks: [] } }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('PROJ-7')
    expect(screen.queryByText(/cloned from/i)).not.toBeInTheDocument()
  })

  it('offers the clone source unchecked and imports only what was ticked', async () => {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '30001', filename: 'customer.log', size: 500, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'CUST-9' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))

    const row = await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(row)

    const box = await screen.findByRole('checkbox', { name: /customer\.log/i })
    expect(box).not.toBeChecked()
    await userEvent.click(box)

    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() =>
      expect(jira.createCase).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'PROJ-7', sources: ['CUST-9'] })
      )
    )
    await waitFor(() =>
      expect(jira.ingestAttachments).toHaveBeenCalledWith(
        'PROJ-7',
        'CUST-9',
        expect.arrayContaining([expect.objectContaining({ id: '30001' })])
      )
    )
  })

  it('does not list a source whose attachments were never expanded', async () => {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '30001', filename: 'customer.log', size: 500, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'CUST-9' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() => expect(jira.createCase).toHaveBeenCalled())
    expect(jira.createCase.mock.calls[0][0].sources).toEqual([])
  })

  it('an expanded source with nothing ticked AND not explicitly included is not imported', async () => {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '30001', filename: 'customer.log', size: 500, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'CUST-9' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))

    const row = await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(row)
    // fully expanded, but nothing ticked and the include control untouched — looking is
    // not choosing, and the include control defaults off.
    await screen.findByRole('checkbox', { name: /customer\.log/i })
    expect(screen.getByRole('checkbox', { name: /include CUST-9/i })).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() => expect(jira.createCase).toHaveBeenCalled())
    expect(jira.createCase.mock.calls[0][0].sources).toEqual([])
  })

  it('a zero-attachment source can be explicitly included', async () => {
    // Regression: KAN-17 had a description and a comment but no files, so nothing was
    // ever tickable and the source was silently dropped under the old rule.
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'KAN-17', summary: 'Customer ticket', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'KAN-17',
      summary: 'Customer ticket',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: []
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'KAN-17' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))

    const row = await screen.findByRole('button', { name: /cloned from KAN-17/i })
    await userEvent.click(row)
    expect(await screen.findByText(/no attachments/i)).toBeInTheDocument()

    const includeBox = screen.getByRole('checkbox', { name: /include KAN-17/i })
    expect(includeBox).not.toBeChecked()
    await userEvent.click(includeBox)

    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() =>
      expect(jira.createCase).toHaveBeenCalledWith(expect.objectContaining({ sources: ['KAN-17'] }))
    )
  })

  it('ticking a source attachment includes the source without touching the include control', async () => {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '30001', filename: 'customer.log', size: 500, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'CUST-9' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))

    const row = await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(row)

    const fileBox = await screen.findByRole('checkbox', { name: /customer\.log/i })
    const includeBox = screen.getByRole('checkbox', { name: /include CUST-9/i })
    expect(includeBox).not.toBeChecked()
    await userEvent.click(fileBox)
    expect(includeBox).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() =>
      expect(jira.createCase).toHaveBeenCalledWith(expect.objectContaining({ sources: ['CUST-9'] }))
    )
  })

  it('including a source does not tick any of its attachments', async () => {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '30001', filename: 'customer.log', size: 500, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'CUST-9' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))

    const row = await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(row)

    const fileBox = await screen.findByRole('checkbox', { name: /customer\.log/i })
    const includeBox = screen.getByRole('checkbox', { name: /include CUST-9/i })
    await userEvent.click(includeBox)
    expect(fileBox).not.toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() =>
      expect(jira.createCase).toHaveBeenCalledWith(expect.objectContaining({ sources: ['CUST-9'] }))
    )
    expect(jira.ingestAttachments).not.toHaveBeenCalledWith('PROJ-7', 'CUST-9', expect.anything())
  })

  it('shows a deduped file as done, attributed to the ticket it was already ingested from', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))
    await waitFor(() => expect(jira.ingestAttachments).toHaveBeenCalled())
    await waitFor(() => expect(progressCb).not.toBeNull())
    act(() =>
      progressCb!({
        caseSlug: 'PROJ-7',
        attachmentId: '10001',
        filename: 'trace.binlog',
        status: 'done',
        evidenceId: 1,
        dedupedFrom: 'CUST-9'
      })
    )
    expect(await screen.findByText(/done/i)).toBeInTheDocument()
    expect(screen.getByText(/CUST-9/)).toBeInTheDocument()
  })

  it('shows a deduped file as done with no "already on" text when the match has no ticket to name', async () => {
    // The matched evidence row had no Jira provenance at all (e.g. a manual upload), so the
    // main process omits dedupedFrom rather than falsely naming the current ticket. The
    // dialog must not fabricate a ticket name either.
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))
    await waitFor(() => expect(jira.ingestAttachments).toHaveBeenCalled())
    await waitFor(() => expect(progressCb).not.toBeNull())
    act(() =>
      progressCb!({
        caseSlug: 'PROJ-7',
        attachmentId: '10001',
        filename: 'trace.binlog',
        status: 'done',
        evidenceId: 1
      })
    )
    expect(await screen.findByText(/done/i)).toBeInTheDocument()
    expect(screen.queryByText(/already on/i)).not.toBeInTheDocument()
  })

  it('ingests the primary batch, then each ticked source, one at a time (not concurrently)', async () => {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '30001', filename: 'customer.log', size: 500, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'CUST-9' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    // The primary's ingestAttachments call stays pending until released, so we can prove
    // the source's call has NOT fired yet while it's outstanding.
    let releasePrimary: (() => void) | undefined
    jira.ingestAttachments = vi.fn((_slug: string, key: string) => {
      if (key === 'PROJ-7') {
        return new Promise((resolve) => {
          releasePrimary = () => resolve({ ok: true, value: [] })
        })
      }
      return Promise.resolve({ ok: true, value: [] })
    })

    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    const row = await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(row)
    const box = await screen.findByRole('checkbox', { name: /customer\.log/i })
    await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() =>
      expect(jira.ingestAttachments).toHaveBeenCalledWith('PROJ-7', 'PROJ-7', expect.anything())
    )
    // While the primary's call is still outstanding, the source must not have started.
    expect(jira.ingestAttachments).not.toHaveBeenCalledWith('PROJ-7', 'CUST-9', expect.anything())

    releasePrimary!()

    await waitFor(() =>
      expect(jira.ingestAttachments).toHaveBeenCalledWith(
        'PROJ-7',
        'CUST-9',
        expect.arrayContaining([expect.objectContaining({ id: '30001' })])
      )
    )
  })

  it('a failed source expansion can be retried and its attachments then render unchecked', async () => {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '30001', filename: 'customer.log', size: 500, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    let previewCalls = 0
    jira.preview = vi.fn(async (key: string) => {
      if (key === 'CUST-9') {
        previewCalls++
        if (previewCalls === 1) return { ok: false, code: 'network', message: 'fetch failed' }
        return { ok: true, value: SOURCE_PREVIEW }
      }
      return { ok: true, value: CLONE_PREVIEW }
    })
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))

    const row = await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(row)

    // first attempt fails — the row must show its error state, not a bare file count
    expect(await screen.findByText(/fetch failed/i)).toBeInTheDocument()
    expect(row).not.toHaveTextContent(/\d+ files/)
    expect(screen.queryByRole('checkbox', { name: /customer\.log/i })).not.toBeInTheDocument()

    // clicking the still-failed row retries the fetch
    await userEvent.click(row)

    const box = await screen.findByRole('checkbox', { name: /customer\.log/i })
    expect(box).not.toBeChecked()
    expect(jira.preview).toHaveBeenCalledTimes(3) // PROJ-7, CUST-9 (fail), CUST-9 (retry)
  })

  /** A clone row that has been fetched. Two files so select-all has something to say. */
  async function openSourceRow(): Promise<HTMLElement> {
    const CLONE_PREVIEW = {
      ...PREVIEW,
      cloneLinks: [
        { key: 'CUST-9', summary: 'Customer report', direction: 'is-cloned-by' as const }
      ]
    }
    const SOURCE_PREVIEW = {
      key: 'CUST-9',
      summary: 'Customer report',
      status: 'Open',
      priority: null,
      labels: [],
      reporter: 'Cust',
      created: 'c',
      updated: 'u',
      cloneLinks: [],
      attachments: [
        { id: '20001', filename: 'customer.log', size: 10, mimeType: 'text/plain', createdAt: 'x' },
        { id: '20002', filename: 'second.log', size: 20, mimeType: 'text/plain', createdAt: 'x' }
      ]
    }
    jira.preview = vi.fn(async (key: string) => ({
      ok: true,
      value: key === 'CUST-9' ? SOURCE_PREVIEW : CLONE_PREVIEW
    }))
    render(<NewCaseDialog {...noop} />)
    await userEvent.type(screen.getByPlaceholderText(/ticket key or link/i), 'PROJ-7')
    await userEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    const row = await screen.findByRole('button', { name: /cloned from CUST-9/i })
    await userEvent.click(row)
    await screen.findByRole('checkbox', { name: /customer\.log/i })
    return row
  }

  it('collapses an expanded source without refetching or losing the selection', async () => {
    const row = await openSourceRow()
    expect(row).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(screen.getByRole('checkbox', { name: /customer\.log/i }))

    await userEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('checkbox', { name: /customer\.log/i })).not.toBeInTheDocument()
    // The decision survives the collapse, so the header has to keep stating it — a closed row
    // that looks inert while still importing a file is the whole hazard here.
    expect(row).toHaveTextContent(/including · 1\/2 files/i)

    await userEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('checkbox', { name: /customer\.log/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /second\.log/i })).not.toBeChecked()
    expect(jira.preview).toHaveBeenCalledTimes(2) // PROJ-7 + one CUST-9 fetch, no refetch
  })

  it('a source collapsed while included is still imported', async () => {
    const row = await openSourceRow()
    await userEvent.click(screen.getByRole('checkbox', { name: /customer\.log/i }))
    await userEvent.click(row) // collapse

    await userEvent.click(screen.getByRole('button', { name: /create case/i }))

    await waitFor(() =>
      expect(jira.createCase).toHaveBeenCalledWith(expect.objectContaining({ sources: ['CUST-9'] }))
    )
  })

  it('selects and deselects every attachment on one source', async () => {
    await openSourceRow()
    const all = screen.getByRole('button', { name: /select all CUST-9/i })

    await userEvent.click(all)
    expect(screen.getByRole('checkbox', { name: /customer\.log/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /second\.log/i })).toBeChecked()
    // Selecting files is consent to the ticket, same rule as ticking one by hand.
    expect(screen.getByRole('checkbox', { name: /include CUST-9/i })).toBeChecked()

    await userEvent.click(screen.getByRole('button', { name: /deselect all CUST-9/i }))
    expect(screen.getByRole('checkbox', { name: /customer\.log/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /second\.log/i })).not.toBeChecked()
    // Clearing the files does NOT withdraw consent — the include control owns that.
    expect(screen.getByRole('checkbox', { name: /include CUST-9/i })).toBeChecked()
  })

  it('names the resolved provider in the preview header', async () => {
    const user = userEvent.setup()
    window.argus.jira.preview = vi.fn(async () => ({
      ok: true,
      value: {
        provider: 'github',
        key: 'cli/cli#14189',
        summary: 'Tiles 403',
        status: 'open',
        priority: null,
        labels: [],
        reporter: 'mislav',
        created: '2026-08-19T10:00:00Z',
        updated: '2026-08-21T17:56:37Z',
        attachments: [],
        cloneLinks: [],
        url: 'https://github.com/cli/cli/issues/14189'
      }
    })) as never
    render(
      <NewCaseDialog onClose={() => {}} onCreateBlank={async () => {}} onOpenCase={() => {}} />
    )
    await user.type(
      screen.getByPlaceholderText(/ticket/i),
      'https://github.com/cli/cli/issues/14189'
    )
    await user.click(screen.getByRole('button', { name: /fetch/i }))
    expect(await screen.findByText(/GitHub issue/i)).toBeInTheDocument()
    expect(screen.getByText('cli/cli#14189')).toBeInTheDocument()
  })

  // Finding C2: `key` for a GitHub preview is `owner/repo#123`, which SLUG_RE rejects (`/`
  // and `#`). Prefilling it verbatim let the Create button spend a real `gh issue view` call
  // before createCase threw "Invalid case slug" — the button was never disabled because
  // `caseSlug.trim()` was still truthy. The prefill must be a slug that actually validates.
  it('prefills a Case ID that satisfies SLUG_RE for a GitHub preview', async () => {
    const user = userEvent.setup()
    window.argus.jira.preview = vi.fn(async () => ({
      ok: true,
      value: {
        provider: 'github',
        key: 'cli/cli#14189',
        summary: 'Tiles 403',
        status: 'open',
        priority: null,
        labels: [],
        reporter: 'mislav',
        created: '2026-08-19T10:00:00Z',
        updated: '2026-08-21T17:56:37Z',
        attachments: [],
        cloneLinks: [],
        url: 'https://github.com/cli/cli/issues/14189'
      }
    })) as never
    render(
      <NewCaseDialog onClose={() => {}} onCreateBlank={async () => {}} onOpenCase={() => {}} />
    )
    await user.type(
      screen.getByPlaceholderText(/ticket/i),
      'https://github.com/cli/cli/issues/14189'
    )
    await user.click(screen.getByRole('button', { name: /fetch/i }))
    const slugInput = await screen.findByLabelText('Case slug')
    expect((slugInput as HTMLInputElement).value).toBe('cli-14189')
    expect(SLUG_RE.test((slugInput as HTMLInputElement).value)).toBe(true)
  })

  // Minor 3: SLUG_RE caps total length at 64. A repo name long enough that `{repo}-{number}`
  // overruns that reproduces the exact C2 flow (a Create click that spends a real `gh issue
  // view` before createCase throws "Invalid case slug") for a different reason — the prefill
  // itself is too long. Asserts against the REAL SLUG_RE, not a restated pattern, so this
  // can't silently drift from what createCase actually enforces.
  //
  // It also asserts the issue number survives truncation: naive `.slice(0, 64)` on the whole
  // `{repo}-{number}` string cuts the number off the END for a repo this long, so every issue
  // in the same long-named repo would prefill the identical Case ID and collide in
  // `createCase` on the second one. Fetching two different issue numbers must produce two
  // different slugs.
  async function fetchGithubSlug(
    user: ReturnType<typeof userEvent.setup>,
    key: string
  ): Promise<string> {
    const [owner, rest] = key.split('/')
    const [repo, numStr] = rest.split('#')
    window.argus.jira.preview = vi.fn(async () => ({
      ok: true,
      value: {
        provider: 'github',
        key,
        summary: 'x',
        status: 'open',
        priority: null,
        labels: [],
        reporter: 'mislav',
        created: '2026-08-19T10:00:00Z',
        updated: '2026-08-21T17:56:37Z',
        attachments: [],
        cloneLinks: [],
        url: `https://github.com/${owner}/${repo}/issues/${numStr}`
      }
    })) as never
    render(
      <NewCaseDialog onClose={() => {}} onCreateBlank={async () => {}} onOpenCase={() => {}} />
    )
    await user.type(
      screen.getByPlaceholderText(/ticket/i),
      `https://github.com/${owner}/${repo}/issues/${numStr}`
    )
    await user.click(screen.getByRole('button', { name: /fetch/i }))
    const slugInput = await screen.findByLabelText('Case slug')
    return (slugInput as HTMLInputElement).value
  }

  it('prefills a Case ID that still satisfies SLUG_RE for a very long GitHub repo name, and keeps the issue number', async () => {
    const longRepo = 'a'.repeat(70)
    const slug1 = await fetchGithubSlug(userEvent.setup(), `owner/${longRepo}#42`)
    expect(SLUG_RE.test(slug1)).toBe(true)
    expect(slug1.endsWith('-42')).toBe(true)

    cleanup()

    const slug2 = await fetchGithubSlug(userEvent.setup(), `owner/${longRepo}#99`)
    expect(SLUG_RE.test(slug2)).toBe(true)
    expect(slug2.endsWith('-99')).toBe(true)

    expect(slug1).not.toBe(slug2)
  })

  // MUST/IMPORTANT (leading-non-alnum repo): `owner/.github` is a real, ubiquitous GitHub repo
  // (community health files) and accepts issues. SLUG_RE requires the first character to be
  // alnum; a naive `{repo}-{number}` prefill of `.github-42` fails SLUG_RE while the Create
  // button stays enabled — the exact C2 failure this prefill exists to prevent.
  it('prefills a valid Case ID for a repo name starting with a dot', async () => {
    const slug = await fetchGithubSlug(userEvent.setup(), 'owner/.github#42')
    expect(SLUG_RE.test(slug)).toBe(true)
    expect(slug.endsWith('-42')).toBe(true)
  })

  it('prefills a valid Case ID for a repo name starting with an underscore', async () => {
    const slug = await fetchGithubSlug(userEvent.setup(), 'owner/_private#42')
    expect(SLUG_RE.test(slug)).toBe(true)
    expect(slug.endsWith('-42')).toBe(true)
  })

  it('prefills a valid Case ID for a repo name starting with a dash', async () => {
    const slug = await fetchGithubSlug(userEvent.setup(), 'owner/-dash#42')
    expect(SLUG_RE.test(slug)).toBe(true)
    expect(slug.endsWith('-42')).toBe(true)
  })

  it('rejects a pull request URL before any fetch', async () => {
    const user = userEvent.setup()
    const preview = vi.fn()
    window.argus.jira.preview = preview as never
    render(
      <NewCaseDialog onClose={() => {}} onCreateBlank={async () => {}} onOpenCase={() => {}} />
    )
    await user.type(screen.getByPlaceholderText(/ticket/i), 'https://github.com/cli/cli/pull/9')
    await user.click(screen.getByRole('button', { name: /fetch/i }))
    expect(await screen.findByText(/pull request, not an issue/i)).toBeInTheDocument()
    expect(preview).not.toHaveBeenCalled()
  })
})
