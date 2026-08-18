// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { NewCaseDialog } from '../NewCaseDialog'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'
import type { JiraAttachmentProgress } from '../../../../shared/jira'

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
})
