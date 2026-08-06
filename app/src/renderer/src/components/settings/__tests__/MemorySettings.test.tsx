// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { MemorySettings } from '../MemorySettings'
import { confirm } from '../../../lib/confirmStore'
import type { MemoryTopicsPayload } from '../../../../../shared/memoryIpc'
import type { UsageStatsPayload } from '../../../../../shared/observability'

// The Argus-styled confirm dialog is exercised in ConfirmHost.test.tsx; here we stub it so
// these tests drive the confirm/cancel branches without mounting the host.
vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

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
    {
      name: 'hot-topic',
      sizeBytes: 2048,
      lastWritten: '2026-07-19T10:00:00.000Z',
      enabled: true,
      scope: 'environment'
    },
    {
      name: 'cold-topic',
      sizeBytes: 1024,
      lastWritten: '2026-01-05T10:00:00.000Z',
      enabled: true,
      scope: 'preference'
    },
    {
      name: 'legacy-topic',
      sizeBytes: 9000,
      lastWritten: '2026-01-05T10:00:00.000Z',
      enabled: true,
      scope: null
    }
  ],
  indexLines: 2,
  capLines: 200,
  capBytes: 4096
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
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('MemorySettings usage + hygiene', () => {
  it('shows recall counts and a stale badge on candidates only', async () => {
    render(<MemorySettings />)
    expect(await screen.findByText(/7 recalls/)).toBeInTheDocument()
    expect(await screen.findByText(/never recalled/)).toBeInTheDocument()
    const stale = await screen.findAllByText('stale')
    expect(stale).toHaveLength(1)
  })

  it('renders the scope chip, the byte size, and an over-cap flag', async () => {
    render(<MemorySettings />)

    expect(await screen.findByText('environment')).toBeInTheDocument()
    expect(screen.getByText('preference')).toBeInTheDocument()
    expect(screen.getByText('2048 B')).toBeInTheDocument()
    expect(screen.getAllByText(/over cap/i)).toHaveLength(1)

    // The unscoped topic (legacy-topic, scope: null) must render no scope chip on its OWN
    // row — not merely no chip reading the literal text "correction" (no fixture even uses
    // that scope, so that assertion could never fail regardless of what legacy-topic renders).
    // Scope to legacy-topic's row and enumerate every chip in it directly: an empty chip or one
    // reading the literal "null" would still show up here, unlike a queryByText probe for one
    // specific string.
    const row = screen.getByText('legacy-topic').closest('[class*="group/row"]')
    if (!row) throw new Error('no row container found for legacy-topic')
    expect(within(row as HTMLElement).queryByText('preference')).not.toBeInTheDocument()
    expect(within(row as HTMLElement).queryByText('environment')).not.toBeInTheDocument()
    expect(within(row as HTMLElement).queryByText('correction')).not.toBeInTheDocument()
    const chipTexts = Array.from(row.querySelectorAll('[class*="rounded-r1"]')).map((el) =>
      el.textContent?.trim()
    )
    // legacy-topic is 9000 bytes (over the 4096-byte cap) with no usage entry, so its only
    // legitimate chips are the byte-size chip and the over-cap flag — a scope chip appearing
    // here would be a third entry, changing this array.
    expect(chipTexts).toEqual(['9000 B', 'over cap'])
  })

  it('archive asks for confirmation then calls memory.archive', async () => {
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Archive cold-topic' }))
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(argus.memory.archive).toHaveBeenCalledWith('cold-topic'))
  })

  it('archived section lists topics with a Restore action', async () => {
    render(<MemorySettings />)
    expect(await screen.findByText('old-lesson')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore old-lesson' }))
    await waitFor(() => expect(argus.memory.restore).toHaveBeenCalledWith('old-lesson'))
  })

  it('cancelling the archive confirm does nothing', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false)
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Archive cold-topic' }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
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
    fireEvent.click(await screen.findByRole('tab', { name: 'Audit' }))
    expect(await screen.findByText('archived')).toBeInTheDocument()
    expect(await screen.findByText('restored')).toBeInTheDocument()
  })

  it('shows provenance for an agent write, with no byte size or action label', async () => {
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
    fireEvent.click(await screen.findByRole('tab', { name: 'Audit' }))
    expect(await screen.findByText('written by NAV-1')).toBeInTheDocument()
    // size is no longer surfaced anywhere in the audit
    expect(screen.queryByText('128 B')).not.toBeInTheDocument()
    expect(screen.queryByText('archived')).not.toBeInTheDocument()
    expect(screen.queryByText('restored')).not.toBeInTheDocument()
  })

  it('labels UI-driven rows "by you" and gives the onboarding seed a friendly name', async () => {
    argus.memory.audit.mockResolvedValue([
      {
        ts: '2026-07-20T22:04:30.000Z',
        caseSlug: 'ui',
        topic: 'nav-drift',
        indexEntry: null,
        bytes: 0,
        action: 'archive'
      },
      {
        ts: '2026-07-16T07:19:00.000Z',
        caseSlug: 'sample-onboarding',
        topic: 'nav-fusion-bearing-discontinuity',
        indexEntry: 'bearing errors follow an IMU warning',
        bytes: 240
      }
    ])
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Audit' }))
    // 'ui' slug reads as the user's own action; the raw slug never appears
    expect(await screen.findByText('by you')).toBeInTheDocument()
    expect(screen.getByText('written by onboarding sample')).toBeInTheDocument()
    expect(screen.queryByText('sample-onboarding')).not.toBeInTheDocument()
  })

  it('collapses the repeated topic name in an archive/restore audit row', async () => {
    // archive/restore save the whole "- [topic](topic.md) — desc" index line; rendering it
    // raw repeated the (long) slug up to four times per row.
    argus.memory.audit.mockResolvedValue([
      {
        ts: '2026-07-20T22:12:00.000Z',
        caseSlug: 'ui',
        topic: 'nav-fusion-bearing-discontinuity',
        indexEntry:
          '- [nav-fusion-bearing-discontinuity](nav-fusion-bearing-discontinuity.md) — nav-fusion-bearing-discontinuity — bearing errors follow an IMU warning',
        bytes: 0,
        action: 'restore'
      }
    ])
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Audit' }))
    // the description collapses to just the summary
    expect(await screen.findByText('— bearing errors follow an IMU warning')).toBeInTheDocument()
    // the markdown-link boilerplate (a second + third copy of the slug) is gone
    expect(screen.queryByText(/\.md\)/)).not.toBeInTheDocument()
    // the topic still appears once, as the row label
    expect(screen.getByText('nav-fusion-bearing-discontinuity')).toBeInTheDocument()
  })

  it('leaves a bare agent-write description untouched', async () => {
    argus.memory.audit.mockResolvedValue([
      {
        ts: '2026-07-20T09:00:00.000Z',
        caseSlug: 'NAV-1',
        topic: 'nav-drift',
        indexEntry: 'bearing errors follow an IMU warning',
        bytes: 128
      }
    ])
    render(<MemorySettings />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Audit' }))
    expect(await screen.findByText('— bearing errors follow an IMU warning')).toBeInTheDocument()
  })

  it('the Audit tab shows audit rows and hides Topics content; switching back restores Topics', async () => {
    argus.memory.audit.mockResolvedValue([
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
    // Topics tab is the default: topic rows visible, audit rows are not
    expect(await screen.findByText('hot-topic')).toBeInTheDocument()
    expect(screen.queryByText('archived')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }))
    expect(await screen.findByText('archived')).toBeInTheDocument()
    expect(screen.getByText('Recent memory activity')).toBeInTheDocument()
    // Topics content is gone while on the Audit tab
    expect(screen.queryByText('hot-topic')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Topics' }))
    expect(await screen.findByText('hot-topic')).toBeInTheDocument()
    expect(screen.queryByText('archived')).not.toBeInTheDocument()
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
