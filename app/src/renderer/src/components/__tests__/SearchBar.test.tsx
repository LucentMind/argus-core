// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SearchBar } from '../SearchBar'
import type { EvidenceHit, ChatHit, SummaryHit } from '../../../../shared/types'

const hit: EvidenceHit = {
  kind: 'evidence',
  evidenceId: 1,
  caseSlug: 'NAVAPI-1',
  relPath: 'evidence/log.txt',
  artifactType: 'applog',
  snippet: '«TileStore» error',
  startLine: 1,
  endLine: 400,
  matchLine: 3
}

beforeEach(() => {
  window.argus = {
    search: { query: vi.fn().mockResolvedValue([hit]) },
    cases: { create: vi.fn(), list: vi.fn() },
    evidence: { ingest: vi.fn(), list: vi.fn(), read: vi.fn() },
    pathForFile: vi.fn()
  } as unknown as typeof window.argus
})

describe('SearchBar', () => {
  it('queries on submit and opens a hit', async () => {
    const onOpen = vi.fn()
    render(<SearchBar caseSlug="NAVAPI-1" onOpen={onOpen} />)
    fireEvent.change(screen.getByPlaceholderText('Search evidence…'), {
      target: { value: 'TileStore' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() => expect(screen.getByText(/evidence\/log\.txt/)).toBeTruthy())
    expect(window.argus.search.query).toHaveBeenCalledWith('TileStore', {
      caseSlug: 'NAVAPI-1',
      evidenceScope: 'investigation'
    })
    fireEvent.click(screen.getByText(/evidence\/log\.txt/))
    expect(onOpen).toHaveBeenCalledWith(hit)
  })

  // The scope buttons are gone (user-directed, 2026-08-02): in the case view this field sits
  // under the Evidence header, so its scope is what its placement says it is. Cross-case search
  // is the dashboard's field, covered below.
  it('offers no scope switch and never widens past the case', async () => {
    render(<SearchBar caseSlug="NAVAPI-1" onOpen={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'search scope' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'All cases' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'This case' })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Search evidence…'), {
      target: { value: 'TileStore' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() =>
      expect(window.argus.search.query).toHaveBeenCalledWith('TileStore', {
        caseSlug: 'NAVAPI-1',
        evidenceScope: 'investigation'
      })
    )
  })

  it('in-case results are ungrouped — every hit is this case', async () => {
    render(<SearchBar caseSlug="NAVAPI-1" onOpen={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Search evidence…'), {
      target: { value: 'TileStore' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() => expect(screen.getByText(/evidence\/log\.txt/)).toBeTruthy())
    // no per-case section label above the list (the dashboard renders those; see below)
    expect(document.querySelectorAll('ul').length).toBe(1)
  })

  it('dashboard search requests evidence + chat, groups by case, and opens chat hits', async () => {
    const chatHit: ChatHit = {
      kind: 'chat',
      caseSlug: 'NAV-2',
      sessionId: 5,
      sessionTitle: 'triage',
      turnId: 3,
      role: 'assistant',
      snippet: '«braking» dropout'
    }
    window.argus.search.query = vi.fn(async () => [hit, chatHit]) as never
    const onOpen = vi.fn()
    render(<SearchBar caseSlug={null} onOpen={onOpen} />)
    fireEvent.change(screen.getByPlaceholderText('Search evidence & chats…'), {
      target: { value: 'braking' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() =>
      expect(window.argus.search.query).toHaveBeenCalledWith('braking', {
        sources: ['evidence', 'chat', 'summaries'],
        evidenceScope: 'investigation'
      })
    )
    // grouped by case: both case slugs appear as section labels
    expect(await screen.findByText('NAV-2')).toBeTruthy()
    fireEvent.click(screen.getByText(/triage/))
    expect(onOpen).toHaveBeenCalledWith(chatHit)
  })

  it('dashboard search surfaces closed-case summary hits and opens them like chat hits', async () => {
    const summaryHit: SummaryHit = {
      kind: 'summary',
      caseSlug: 'NAV-9',
      signature: 'braking sensor dropout under load',
      resolution: 'solved',
      snippet: '«braking» sensor intermittent'
    }
    window.argus.search.query = vi.fn(async () => [summaryHit]) as never
    const onOpen = vi.fn()
    render(<SearchBar caseSlug={null} onOpen={onOpen} />)
    fireEvent.change(screen.getByPlaceholderText('Search evidence & chats…'), {
      target: { value: 'braking' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() =>
      expect(window.argus.search.query).toHaveBeenCalledWith('braking', {
        sources: ['evidence', 'chat', 'summaries'],
        evidenceScope: 'investigation'
      })
    )
    expect(await screen.findByText(/closed case/)).toBeTruthy()
    fireEvent.click(screen.getByText(/braking sensor dropout under load/))
    expect(onOpen).toHaveBeenCalledWith(summaryHit)
  })

  it('chat hits without a title fall back to the session id', async () => {
    window.argus.search.query = vi.fn(async () => [
      {
        kind: 'chat',
        caseSlug: 'NAV-2',
        sessionId: 9,
        sessionTitle: '',
        turnId: null,
        role: 'user',
        snippet: 's'
      }
    ]) as never
    render(<SearchBar caseSlug={null} onOpen={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Search evidence & chats…'), {
      target: { value: 'x' }
    })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText(/session 9/)).toBeTruthy()
  })
})
