// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

function mkCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 1,
    slug: 'NAV-1',
    title: 'Bearing jumps',
    jiraKey: 'NAV-1',
    jiraSyncedAt: null,
    jiraDeselected: [],
    jiraStatus: null,
    jiraPriority: null,
    jiraCommentCount: null,
    jiraAttachmentIds: [],
    reviewBaseline: null,
    lastSyncError: null,
    status: 'analyzing',
    resolution: null,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    actionItems: [],
    ...overrides
  }
}

const noopHandlers = {
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onImport: vi.fn(),
  onDeleted: vi.fn()
}

beforeEach(() => {
  window.argus = {
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    proposals: { list: vi.fn().mockResolvedValue({ proposals: [] }) },
    bundle: { export: vi.fn() },
    cases: { delete: vi.fn() },
    jira: {
      syncAll: vi.fn().mockResolvedValue({ ok: true, value: { synced: 0, failed: 0 } }),
      onSyncProgress: vi.fn(() => () => {})
    }
  } as never
  settingsStore.reset()
})

describe('CaseDashboard triage', () => {
  it('renders action items as chips', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            actionItems: [{ kind: 'comments', severity: 'action', label: '2 new comments' }]
          })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText('2 new comments')).toBeInTheDocument()
  })

  it('renders info items as muted text, not chips', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({ actionItems: [{ kind: 'stale', severity: 'info', label: 'synced 9d ago' }] })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText('synced 9d ago')).toBeInTheDocument()
  })

  it('shows the jira priority', () => {
    render(<CaseDashboard cases={[mkCase({ jiraPriority: 'High' })]} {...noopHandlers} />)
    expect(screen.getByText(/High/)).toBeInTheDocument()
  })

  it('renders a sync failure on the card itself', () => {
    render(
      <CaseDashboard
        cases={[
          mkCase({
            actionItems: [{ kind: 'sync-error', severity: 'action', label: 'sync failed — auth' }]
          })
        ]}
        {...noopHandlers}
      />
    )
    expect(screen.getByText('sync failed — auth')).toBeInTheDocument()
  })

  it('renders no action row when there is nothing to do', () => {
    render(<CaseDashboard cases={[mkCase({ actionItems: [] })]} {...noopHandlers} />)
    expect(screen.queryByTestId('action-items')).not.toBeInTheDocument()
  })
})
