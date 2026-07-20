// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { CaseDashboard } from '../CaseDashboard'
import { settingsStore } from '../../lib/settingsStore'
import { defaultSettings, type SettingsPayload } from '../../../../shared/settings'
import type { CaseRecord } from '../../../../shared/types'

const cases: CaseRecord[] = [
  {
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
    updatedAt: '2026-07-08T00:00:00Z'
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

// copied from CaseDashboard.test.tsx (no exported defaultProps there — props are
// inlined per-test), so we reconstruct the minimal signature-matching props here.
const defaultProps = {
  cases,
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onImport: vi.fn(),
  onDeleted: vi.fn()
}

beforeEach(() => {
  window.argus = {
    settings: { get: vi.fn(async () => payload()), onChanged: vi.fn(() => () => {}) }
  } as never
  settingsStore.reset()
  ;(window as never as { argus: Record<string, unknown> }).argus.proposals = {
    list: vi.fn().mockResolvedValue({ proposals: [{ file: 'a.md' }, { file: 'b.md' }] })
  }
})

describe('knowledge pending line', () => {
  it('shows the pending count when > 0', async () => {
    render(<CaseDashboard {...defaultProps} />)
    expect(await screen.findByText(/Knowledge review pending: 2/)).toBeInTheDocument()
  })

  it('hides when 0', async () => {
    ;(
      window as never as { argus: { proposals: { list: ReturnType<typeof vi.fn> } } }
    ).argus.proposals.list.mockResolvedValue({ proposals: [] })
    render(<CaseDashboard {...defaultProps} />)
    await waitFor(() =>
      expect(screen.queryByText(/Knowledge review pending/)).not.toBeInTheDocument()
    )
  })
})
