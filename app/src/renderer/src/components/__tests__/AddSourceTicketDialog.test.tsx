// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AddSourceTicketDialog } from '../AddSourceTicketDialog'
import { __resetEscapeLayersForTest } from '../../lib/escapeLayer'
import type { CloneLink, JiraIssuePreview } from '../../../../shared/jira'

const preview = (cloneLinks: CloneLink[]): JiraIssuePreview => ({
  key: 'NAV-7',
  summary: 'Own ticket',
  status: 'Open',
  priority: null,
  labels: [],
  reporter: null,
  created: 'c',
  updated: 'u',
  attachments: [],
  cloneLinks
})

beforeEach(() => {
  window.argus = {
    jira: {
      preview: vi.fn(async () => ({ ok: true, value: preview([]) })),
      addSource: vi.fn(async () => ({ ok: true, value: preview([]) }))
    }
  } as never
})

afterEach(() => __resetEscapeLayersForTest())

describe('AddSourceTicketDialog', () => {
  it('offers the discovered clone links and adds the chosen one', async () => {
    window.argus.jira.preview = vi.fn(async () => ({
      ok: true,
      value: preview([{ key: 'CUST-9', summary: 'Customer report', direction: 'clones' as const }])
    })) as never
    const onAdded = vi.fn()
    const onClose = vi.fn()
    render(
      <AddSourceTicketDialog slug="NAV-7" jiraKey="NAV-7" onClose={onClose} onAdded={onAdded} />
    )

    await userEvent.click(await screen.findByRole('button', { name: /CUST-9/ }))
    await waitFor(() => expect(window.argus.jira.addSource).toHaveBeenCalledWith('NAV-7', 'CUST-9'))
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('adds a typed key that was not discovered', async () => {
    render(
      <AddSourceTicketDialog slug="NAV-7" jiraKey="NAV-7" onClose={vi.fn()} onAdded={vi.fn()} />
    )

    await userEvent.type(await screen.findByPlaceholderText(/ticket key/i), 'OTHER-3')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() =>
      expect(window.argus.jira.addSource).toHaveBeenCalledWith('NAV-7', 'OTHER-3')
    )
  })

  // A pasted "Copy link" URL is the shape Jira's own UI hands the user; parseJiraKeyInput
  // already covers it for New case, and this field must not be the one place it 404s.
  it('accepts a pasted browse URL as a key', async () => {
    render(
      <AddSourceTicketDialog slug="NAV-7" jiraKey="NAV-7" onClose={vi.fn()} onAdded={vi.fn()} />
    )
    await userEvent.type(
      await screen.findByPlaceholderText(/ticket key/i),
      'https://acme.atlassian.net/browse/OTHER-3'
    )
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))
    await waitFor(() =>
      expect(window.argus.jira.addSource).toHaveBeenCalledWith('NAV-7', 'OTHER-3')
    )
  })

  it('surfaces an add failure without closing', async () => {
    window.argus.jira.preview = vi.fn(async () => ({
      ok: false,
      code: 'not-found',
      message: 'not found'
    })) as never
    const onClose = vi.fn()
    render(
      <AddSourceTicketDialog slug="NAV-7" jiraKey="NAV-7" onClose={onClose} onAdded={vi.fn()} />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/i)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and reports the reason when the add itself fails', async () => {
    window.argus.jira.addSource = vi.fn(async () => ({
      ok: false,
      code: 'internal',
      message: "OTHER-3 is already this case's ticket"
    })) as never
    const onClose = vi.fn()
    const onAdded = vi.fn()
    render(
      <AddSourceTicketDialog slug="NAV-7" jiraKey="NAV-7" onClose={onClose} onAdded={onAdded} />
    )
    await userEvent.type(await screen.findByPlaceholderText(/ticket key/i), 'OTHER-3')
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already this case's ticket/i)
    expect(onAdded).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
