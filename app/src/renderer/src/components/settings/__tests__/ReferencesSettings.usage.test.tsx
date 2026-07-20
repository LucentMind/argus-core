// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ReferencesSettings } from '../ReferencesSettings'

vi.mock('../../../lib/referenceSyncStore', () => ({
  referenceSyncStore: { set: vi.fn() },
  useRefSyncPayload: () => ({
    config: { spaces: [] },
    loadError: null,
    cards: [],
    references: [
      {
        file: 'triage.md',
        tier: 'confluence',
        stale: false,
        lastSynced: '2026-07-01T00:00:00.000Z',
        sourceCount: 1
      },
      { file: 'unread.md', tier: null, stale: false, lastSynced: null, sourceCount: 0 }
    ]
  })
}))
vi.mock('../../../lib/connectorsStore', () => ({ useConnectorsPayload: () => null }))

beforeEach(() => {
  ;(window as unknown as { argus: unknown }).argus = {
    usage: {
      stats: vi.fn().mockResolvedValue({
        hygiene: { staleDays: 45, minRecalls: 3, trackingStartedAt: '' },
        skills: [],
        memory: [],
        references: [
          { relPath: 'triage.md', readCount: 5, lastReadAt: '2026-07-15T00:00:00.000Z' },
          { relPath: 'unread.md', readCount: 0, lastReadAt: null }
        ],
        archived: []
      })
    },
    refsync: { searchRefs: vi.fn().mockResolvedValue([]) }
  }
})

describe('ReferencesSettings read counts', () => {
  it('shows per-reference read counts and flags never-read files', async () => {
    render(<ReferencesSettings />)
    expect(await screen.findByText(/5 reads · last 2026-07-15/)).toBeInTheDocument()
    expect(await screen.findByText(/never read/)).toBeInTheDocument()
  })
})
