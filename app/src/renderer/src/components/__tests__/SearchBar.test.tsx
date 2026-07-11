// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SearchBar } from '../SearchBar'
import type { EvidenceHit, ChatHit } from '../../../../shared/types'

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
    expect(window.argus.search.query).toHaveBeenCalledWith('TileStore', { caseSlug: 'NAVAPI-1' })
    fireEvent.click(screen.getByText(/evidence\/log\.txt/))
    expect(onOpen).toHaveBeenCalledWith(hit)
  })

  it('All cases scope sends empty filters and groups results by case', async () => {
    window.argus.search.query = vi.fn(async () => [
      {
        kind: 'evidence',
        evidenceId: 1,
        caseSlug: 'NAV-2',
        relPath: 'a.txt',
        artifactType: 'applog',
        snippet: 's',
        startLine: 1,
        endLine: 4,
        matchLine: 2
      },
      {
        kind: 'evidence',
        evidenceId: 2,
        caseSlug: 'NAVAPI-1',
        relPath: 'b.txt',
        artifactType: 'applog',
        snippet: 's',
        startLine: 1,
        endLine: 4,
        matchLine: 3
      }
    ]) as never
    render(<SearchBar caseSlug="NAVAPI-1" onOpen={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'All cases' }))
    fireEvent.change(screen.getByPlaceholderText('Search evidence…'), {
      target: { value: 'TileStore' }
    })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() => expect(window.argus.search.query).toHaveBeenCalledWith('TileStore', {}))
    const headers = await screen.findAllByText(/NAV(API)?-\d/, { selector: 'span,div,h3' })
    expect(headers.length).toBeGreaterThan(0)
    // current case group renders before the other case
    const text = document.body.textContent!
    expect(text.indexOf('NAVAPI-1')).toBeLessThan(text.indexOf('NAV-2'))
  })

  it('no toggle on the dashboard (caseSlug null)', () => {
    render(<SearchBar caseSlug={null} onOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'All cases' })).toBeNull()
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
        sources: ['evidence', 'chat']
      })
    )
    // grouped by case: both case slugs appear as section labels
    expect(await screen.findByText('NAV-2')).toBeTruthy()
    fireEvent.click(screen.getByText(/triage/))
    expect(onOpen).toHaveBeenCalledWith(chatHit)
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
