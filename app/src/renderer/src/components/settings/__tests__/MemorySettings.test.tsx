// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { MemorySettings } from '../MemorySettings'
import type { MemoryTopicsPayload } from '../../../../../shared/memoryIpc'
import type { UsageStatsPayload } from '../../../../../shared/observability'

// MemorySettings reads enablement via useAccessPayload/accessStore, which is a separate
// external-store singleton (not part of window.argus.memory/usage). Mocking it here keeps
// this suite focused on the usage/hygiene/archive behavior under test — accessStore's own
// IPC wiring (access.get/onChanged) is covered by its own tests.
vi.mock('../../../lib/accessStore', () => ({
  accessStore: { patch: vi.fn() },
  useAccessPayload: () => null
}))

const topics: MemoryTopicsPayload = {
  topics: [
    { name: 'hot-topic', sizeBytes: 2048, lastWritten: '2026-07-19T10:00:00.000Z', enabled: true },
    { name: 'cold-topic', sizeBytes: 1024, lastWritten: '2026-01-05T10:00:00.000Z', enabled: true }
  ],
  indexLines: 2,
  capLines: 200
}
const usage: UsageStatsPayload = {
  hygiene: { staleDays: 45, minRecalls: 3, trackingStartedAt: '2026-01-01T00:00:00.000Z' },
  skills: [],
  memory: [
    {
      topic: 'hot-topic',
      recallCount: 7,
      lastRecalledAt: '2026-07-19T10:00:00.000Z',
      lastWrittenAt: '2026-07-19T10:00:00.000Z',
      staleCandidate: false
    },
    {
      topic: 'cold-topic',
      recallCount: 0,
      lastRecalledAt: null,
      lastWrittenAt: '2026-01-05T10:00:00.000Z',
      staleCandidate: true
    }
  ],
  references: [],
  archived: [{ topic: 'old-lesson', archivedAt: '2026-06-01T00:00:00.000Z', sizeBytes: 512 }]
}

function mockArgus(): {
  memory: {
    topics: ReturnType<typeof vi.fn>
    audit: ReturnType<typeof vi.fn>
    read: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    archive: ReturnType<typeof vi.fn>
    restore: ReturnType<typeof vi.fn>
  }
  usage: { stats: ReturnType<typeof vi.fn> }
} {
  return {
    memory: {
      topics: vi.fn().mockResolvedValue(topics),
      audit: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue(''),
      write: vi.fn().mockResolvedValue(topics),
      remove: vi.fn().mockResolvedValue(topics),
      archive: vi.fn().mockResolvedValue(topics),
      restore: vi.fn().mockResolvedValue(topics)
    },
    usage: { stats: vi.fn().mockResolvedValue(usage) }
  }
}
let argus: ReturnType<typeof mockArgus>
beforeEach(() => {
  argus = mockArgus()
  ;(window as unknown as { argus: unknown }).argus = argus
  window.confirm = vi.fn(() => true)
})

describe('MemorySettings usage + hygiene', () => {
  it('shows recall counts and a stale badge on candidates only', async () => {
    render(<MemorySettings />)
    expect(await screen.findByText(/7 recalls/)).toBeInTheDocument()
    expect(await screen.findByText(/never recalled/)).toBeInTheDocument()
    const stale = await screen.findAllByText('stale')
    expect(stale).toHaveLength(1)
  })

  it('archive asks for confirmation then calls memory.archive', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Archive cold-topic' }))
    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => expect(argus.memory.archive).toHaveBeenCalledWith('cold-topic'))
  })

  it('archived section lists topics with a Restore action', async () => {
    render(<MemorySettings />)
    expect(await screen.findByText('old-lesson')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore old-lesson' }))
    await waitFor(() => expect(argus.memory.restore).toHaveBeenCalledWith('old-lesson'))
  })

  it('cancelling the archive confirm does nothing', async () => {
    window.confirm = vi.fn(() => false)
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Archive cold-topic' }))
    expect(argus.memory.archive).not.toHaveBeenCalled()
  })

  it('distinguishes an archive from a restore of the same topic in the audit trail', async () => {
    // Regression: archive and restore both have caseSlug 'ui', bytes 0, and the same
    // saved indexEntry, so without rendering `action` the two rows are byte-identical.
    argus.memory.audit.mockResolvedValue([
      {
        ts: '2026-07-20T22:04:30.000Z',
        caseSlug: 'ui',
        topic: 'nav-drift',
        indexEntry: '- [nav-drift](nav-drift.md) — bearing errors follow an IMU warning',
        bytes: 0,
        action: 'restore'
      },
      {
        ts: '2026-07-20T22:04:10.000Z',
        caseSlug: 'ui',
        topic: 'nav-drift',
        indexEntry: '- [nav-drift](nav-drift.md) — bearing errors follow an IMU warning',
        bytes: 0,
        action: 'archive'
      }
    ])
    render(<MemorySettings />)
    expect(await screen.findByText('archived')).toBeInTheDocument()
    expect(await screen.findByText('restored')).toBeInTheDocument()
  })

  it('shows the byte size for an agent write but not its action label', async () => {
    argus.memory.audit.mockResolvedValue([
      {
        ts: '2026-07-20T09:00:00.000Z',
        caseSlug: 'NAV-1',
        topic: 'nav-drift',
        indexEntry: null,
        bytes: 128
      }
    ])
    render(<MemorySettings />)
    expect(await screen.findByText('128 B')).toBeInTheDocument()
    expect(screen.queryByText('archived')).not.toBeInTheDocument()
    expect(screen.queryByText('restored')).not.toBeInTheDocument()
  })

  it('surfaces a restore failure (e.g. live namesake collision) as an alert', async () => {
    argus.memory.restore.mockRejectedValue(
      new Error('A live topic named "old-lesson" already exists — resolve manually')
    )
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore old-lesson' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/already exists/)
  })
})
