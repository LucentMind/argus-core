// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SyncBadge } from '../SyncBadge'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

function mkCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 1,
    slug: 'NAV-1',
    title: 'Bearing jumps',
    jiraKey: 'NAV-1',
    jiraSyncedAt: '2026-07-08T00:00:00Z',
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: null,
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: 'open',
    resolution: null,
    phase: 'open',
    activeMode: DEFAULT_MODE,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    actionItems: [],
    ...over
  }
}

afterEach(() => vi.useRealTimers())

function freezeAt(iso: string): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

describe('SyncBadge', () => {
  it('renders nothing for a case with no ticket — there is no sync to report', () => {
    const { container } = render(<SyncBadge c={mkCase({ jiraKey: null })} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the age alone when sync is clean — the icon already says "sync"', () => {
    freezeAt('2026-07-11T00:00:00Z')
    render(<SyncBadge c={mkCase()} />)
    expect(screen.getByTestId('sync-badge').textContent).toBe('3d ago')
  })

  it('names the failure and keeps the age, in danger tone — the age comes from the failure, not the last success', () => {
    freezeAt('2026-07-11T00:00:00Z')
    render(
      <SyncBadge
        c={mkCase({
          // jiraSyncedAt (mkCase default) is 2026-07-08 — 3d ago from the freeze. The
          // failure is 2 days younger, so a correct badge reads 2d ago, not 3d ago.
          lastSyncError: { code: 'auth', message: 'token expired', at: '2026-07-09T00:00:00Z' }
        })}
      />
    )
    const badge = screen.getByTestId('sync-badge')
    expect(badge.textContent).toBe('failed 2d ago')
    expect(badge.className).toContain('text-danger')
  })

  it('says never for a linked case that has never synced', () => {
    render(<SyncBadge c={mkCase({ jiraSyncedAt: null })} />)
    expect(screen.getByTestId('sync-badge').textContent).toBe('never')
  })

  it('still shows the failure age when the case never had a successful sync', () => {
    freezeAt('2026-07-14T00:00:00Z')
    render(
      <SyncBadge
        c={mkCase({
          jiraSyncedAt: null,
          lastSyncError: { code: 'auth', message: 'no', at: '2026-07-11T00:00:00Z' }
        })}
      />
    )
    expect(screen.getByTestId('sync-badge').textContent).toBe('failed 3d ago')
    // Wording reads naturally for the never-synced case, not "(last success: never synced)".
    expect(screen.getByTestId('sync-badge').getAttribute('title')).toContain('(never synced)')
  })

  it('reads the failure age, not the stale last-success age — the actual defect', () => {
    // Last success was 12 days ago; the sync broke 10 minutes ago. The badge must say
    // today (from the failure), never 12d ago (from the last success).
    freezeAt('2026-07-11T00:00:00Z')
    render(
      <SyncBadge
        c={mkCase({
          jiraSyncedAt: '2026-06-29T00:00:00Z',
          lastSyncError: { code: 'auth', message: 'token expired', at: '2026-07-10T23:50:00Z' }
        })}
      />
    )
    const badge = screen.getByTestId('sync-badge')
    expect(badge.textContent).toBe('failed today')
    expect(badge.textContent).not.toBe('failed 12d ago')
  })

  it('puts the precise timestamp in the tooltip, not on screen', () => {
    freezeAt('2026-07-11T00:00:00Z')
    render(<SyncBadge c={mkCase()} />)
    expect(screen.getByTestId('sync-badge').getAttribute('title')).toContain('2026')
  })

  it('tooltips the failure reason', () => {
    render(
      <SyncBadge
        c={mkCase({
          lastSyncError: { code: 'auth', message: 'token expired', at: '2026-07-11T00:00:00Z' }
        })}
      />
    )
    expect(screen.getByTestId('sync-badge').getAttribute('title')).toContain('token expired')
  })
})
