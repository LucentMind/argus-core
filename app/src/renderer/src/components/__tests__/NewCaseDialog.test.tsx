// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { NewCaseDialog } from '../NewCaseDialog'
import type { JiraAttachmentProgress } from '../../../../shared/jira'

const PREVIEW = {
  key: 'PROJ-7',
  summary: 'Route flickers',
  status: 'Open',
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
  ]
}

let progressCb: ((p: JiraAttachmentProgress) => void) | null
let jira: {
  preview: ReturnType<typeof vi.fn>
  createCase: ReturnType<typeof vi.fn>
  ingestAttachments: ReturnType<typeof vi.fn>
  onAttachmentProgress: ReturnType<typeof vi.fn>
  setAttachmentSelection: ReturnType<typeof vi.fn>
}

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
})

const noop = { onClose: vi.fn(), onCreateBlank: vi.fn(async () => {}), onOpenCase: vi.fn() }

describe('NewCaseDialog', () => {
  it('fetches a ticket and prefills slug + title from key + summary', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    expect(await screen.findByDisplayValue('PROJ-7')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Route flickers')).toBeInTheDocument()
    // attachments pre-checked
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    for (const b of boxes) expect(b).toBeChecked()
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
    fireEvent.click(screen.getAllByRole('checkbox')[1]) // uncheck log.txt
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))
    await waitFor(() =>
      expect(jira.ingestAttachments).toHaveBeenCalledWith('PROJ-7', [PREVIEW.attachments[0]])
    )
    progressCb!({
      caseSlug: 'PROJ-7',
      attachmentId: '10001',
      filename: 'trace.binlog',
      status: 'downloading'
    })
    progressCb!({
      caseSlug: 'PROJ-7',
      attachmentId: '10001',
      filename: 'trace.binlog',
      status: 'done',
      evidenceId: 1
    })
    expect(await screen.findByText(/done/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /start triage/i }))
    expect(noop.onOpenCase).toHaveBeenCalledWith('PROJ-7')
  })

  it('persists deselected attachment ids after case creation', async () => {
    render(<NewCaseDialog {...noop} />)
    fireEvent.change(screen.getByPlaceholderText(/PROJ-1234/i), { target: { value: 'PROJ-7' } })
    fireEvent.click(screen.getByRole('button', { name: /fetch ticket/i }))
    await screen.findByDisplayValue('Route flickers')
    fireEvent.click(screen.getAllByRole('checkbox')[1]) // uncheck log.txt
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
    progressCb!({
      caseSlug: 'PROJ-7',
      attachmentId: '10001',
      filename: 'trace.binlog',
      status: 'error',
      error: 'boom'
    })
    const retry = await screen.findByRole('button', { name: /retry/i })
    fireEvent.click(retry)
    await waitFor(() =>
      expect(jira.ingestAttachments).toHaveBeenLastCalledWith('PROJ-7', [PREVIEW.attachments[0]])
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
})
