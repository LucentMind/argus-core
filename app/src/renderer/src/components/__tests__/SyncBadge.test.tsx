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
    status: 'analyzing',
    resolution: null,
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

  it('names the failure and keeps the age, in danger tone', () => {
    freezeAt('2026-07-11T00:00:00Z')
    render(
      <SyncBadge
        c={mkCase({
          lastSyncError: { code: 'auth', message: 'token expired', at: '2026-07-11T00:00:00Z' }
        })}
      />
    )
    const badge = screen.getByTestId('sync-badge')
    expect(badge.textContent).toBe('failed 3d ago')
    expect(badge.className).toContain('text-danger')
  })

  it('says never for a linked case that has never synced', () => {
    render(<SyncBadge c={mkCase({ jiraSyncedAt: null })} />)
    expect(screen.getByTestId('sync-badge').textContent).toBe('never')
  })

  it('drops the age from a failure that never synced at all', () => {
    render(
      <SyncBadge
        c={mkCase({
          jiraSyncedAt: null,
          lastSyncError: { code: 'auth', message: 'no', at: '2026-07-11T00:00:00Z' }
        })}
      />
    )
    expect(screen.getByTestId('sync-badge').textContent).toBe('failed')
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
