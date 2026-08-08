// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { uiStore } from '../../lib/uiStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'
import { DEFAULT_MODE } from '../../../../shared/modes'

const cases: CaseRecord[] = [
  {
    id: 1,
    slug: 'NAV-1',
    origin: 'user',
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
    status: 'open',
    resolution: null,
    phase: 'open',
    activeMode: DEFAULT_MODE,
    tags: [],
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    actionItems: []
  }
]

function payload(): SettingsPayload {
  return {
    settings: defaultSettings(),
    resolvedTools: [],
    dataRoot: { path: 'C:\\Users\\x\\Argus', fromEnv: false },
    loadError: null
  }
}

beforeEach(() => {
  window.argus = {
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) },
    proposals: { list: vi.fn().mockResolvedValue({ proposals: [] }) },
    // The dashboard mounts usePrStatuses for every case, which reads the cache and
    // subscribes through these on mount.
    pr: {
      statusList: vi.fn(async () => ({})),
      statusRefresh: vi.fn(async () => ({})),
      onStatusChanged: vi.fn(() => () => {})
    },

    jira: {
      syncAll: vi.fn().mockResolvedValue({ ok: true, value: { synced: 0, changed: 0, failed: 0 } }),
      onSyncProgress: vi.fn(() => () => {})
    }
  } as never
  settingsStore.reset()
  localStorage.clear()
  uiStore.setDynamicTheme(false)
})

describe('CaseDashboard dynamic mode', () => {
  it('classic by default: no glass cards, no dyn primary', () => {
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    expect(document.querySelector('.glass-card')).toBeNull()
    expect(
      (screen.getByRole('button', { name: /new case/i }) as HTMLElement).className
    ).not.toContain('dyn-btn-primary')
  })

  it('dynamic: glass cards with staggered delays and the gradient primary', () => {
    uiStore.setDynamicTheme(true)
    render(
      <CaseDashboard
        cases={cases}
        onOpen={vi.fn()}
        onNew={vi.fn()}
        onImport={vi.fn()}
        onDeleted={vi.fn()}
      />
    )
    const card = document.querySelector('.glass-card') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.style.getPropertyValue('--d')).toBe('50ms') // index 0
    expect((screen.getByRole('button', { name: /new case/i }) as HTMLElement).className).toContain(
      'dyn-btn-primary'
    )
  })
})
