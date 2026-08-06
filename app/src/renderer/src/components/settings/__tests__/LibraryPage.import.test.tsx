// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { LibraryPage } from '../LibraryPage'
import { referenceSyncStore } from '../../../lib/referenceSyncStore'
import type { SkillsPayload } from '../../../../../shared/memoryIpc'
import type { RefSyncPayload } from '../../../../../shared/referenceSync'

const initial: SkillsPayload = { skills: [] }
const refPayload: RefSyncPayload = {
  config: { spaces: [] } as unknown as RefSyncPayload['config'],
  loadError: null,
  cards: [],
  references: []
}

function mockArgus(): {
  skills: {
    list: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
    scanImport: ReturnType<typeof vi.fn>
    applyImport: ReturnType<typeof vi.fn>
  }
  usage: { stats: ReturnType<typeof vi.fn> }
  hivemind: { get: ReturnType<typeof vi.fn> }
  sourceControl: { status: ReturnType<typeof vi.fn> }
  refsync: {
    get: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
    searchRefs: ReturnType<typeof vi.fn>
  }
  workspaces: { pick: ReturnType<typeof vi.fn> }
  editor: { open: ReturnType<typeof vi.fn> }
} {
  return {
    skills: {
      list: vi.fn().mockResolvedValue(initial),
      onChanged: vi.fn(() => () => {}),
      scanImport: vi.fn().mockResolvedValue([]),
      applyImport: vi.fn()
    },
    usage: {
      stats: vi.fn().mockResolvedValue({
        hygiene: { staleDays: 45, minRecalls: 3, trackingStartedAt: '2026-01-01T00:00:00.000Z' },
        skills: [],
        memory: [],
        references: [],
        archived: []
      })
    },
    hivemind: {
      get: vi.fn().mockResolvedValue({
        repo: 'acme/hivemind',
        state: 'ready',
        error: null,
        headCommit: null,
        lastSynced: null,
        items: [],
        pushable: [],
        pushes: {}
      })
    },
    sourceControl: {
      status: vi.fn().mockResolvedValue({
        installed: true,
        version: '2.62',
        authenticated: true,
        login: 'me',
        detail: ''
      })
    },
    refsync: {
      get: vi.fn().mockResolvedValue(refPayload),
      onChanged: vi.fn(() => () => {}),
      searchRefs: vi.fn().mockResolvedValue([])
    },
    workspaces: { pick: vi.fn() },
    editor: { open: vi.fn().mockResolvedValue(undefined) }
  }
}

let argus: ReturnType<typeof mockArgus>

beforeEach(() => {
  referenceSyncStore.reset()
  argus = mockArgus()
  ;(window as unknown as { argus: unknown }).argus = argus
})

describe('LibraryPage import from Claude', () => {
  it('opens the import dialog from the New menu and closes on Cancel', async () => {
    render(<LibraryPage />)
    await waitFor(() => expect(argus.skills.list).toHaveBeenCalled())
    await userEvent.click(await screen.findByRole('button', { name: /^new$/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /import from claude/i }))
    expect(
      await screen.findByRole('dialog', { name: 'Import skills from Claude' })
    ).toBeInTheDocument()
    await waitFor(() => expect(argus.skills.scanImport).toHaveBeenCalledWith({ kind: 'global' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Import skills from Claude' })
      ).not.toBeInTheDocument()
    )
  })
})
