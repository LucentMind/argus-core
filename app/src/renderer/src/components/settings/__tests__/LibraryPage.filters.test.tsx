// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { LibraryPage } from '../LibraryPage'
import { confirm } from '../../../lib/confirmStore'
import { referenceSyncStore } from '../../../lib/referenceSyncStore'
import type { SkillsPayload } from '../../../../../shared/memoryIpc'
import type { RefSyncPayload } from '../../../../../shared/referenceSync'

vi.mock('../../../lib/confirmStore', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
  alert: vi.fn(() => Promise.resolve())
}))

const initial: SkillsPayload = {
  skills: [
    {
      name: 'rca',
      tier: 'user',
      description: 'local adaptation',
      enabled: true,
      shadows: ['hivemind', 'bundled']
    },
    { name: 'my-notes', tier: 'user', description: 'plain user skill', enabled: true, shadows: [] },
    { name: 'hive-probe', tier: 'hivemind', description: 'probe', enabled: true, shadows: [] },
    { name: 'analyze-applog', tier: 'bundled', description: 'applog', enabled: true, shadows: [] }
  ]
}

const ghOk = { installed: true, version: '2.62', authenticated: true, login: 'me', detail: '' }

function hivePayload(pushes: Record<string, { prUrl: string; pushedAt: string }>): unknown {
  return {
    repo: 'acme/hivemind',
    state: 'ready',
    error: null,
    headCommit: null,
    lastSynced: null,
    items: [],
    pushable: [],
    pushes
  }
}

const refPayload: RefSyncPayload = {
  config: { spaces: [] } as unknown as RefSyncPayload['config'],
  loadError: null,
  cards: [],
  references: [
    { file: 'team-tips.md', tier: 'user', lastSynced: null, sourceCount: 0, stale: false },
    {
      file: 'nav-runbook.md',
      tier: 'confluence',
      lastSynced: '2026-07-20T00:00:00.000Z',
      sourceCount: 3,
      stale: true
    }
  ]
}

function mockArgus(): {
  skills: { list: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> }
  usage: { stats: ReturnType<typeof vi.fn> }
  access: { patch: ReturnType<typeof vi.fn> }
  hivemind: {
    get: ReturnType<typeof vi.fn>
    pushPreview: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
  }
  sourceControl: { status: ReturnType<typeof vi.fn> }
  refsync: {
    get: ReturnType<typeof vi.fn>
    onChanged: ReturnType<typeof vi.fn>
    searchRefs: ReturnType<typeof vi.fn>
    readRef: ReturnType<typeof vi.fn>
  }
  openExternal: ReturnType<typeof vi.fn>
} {
  return {
    skills: {
      list: vi.fn().mockResolvedValue(initial),
      deleteUser: vi.fn().mockResolvedValue(initial)
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
      get: vi.fn().mockResolvedValue(hivePayload({})),
      pushPreview: vi.fn().mockResolvedValue('# rca'),
      push: vi
        .fn()
        .mockResolvedValue({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/12' })
    },
    sourceControl: { status: vi.fn().mockResolvedValue(ghOk) },
    access: {
      patch: vi.fn().mockResolvedValue({ access: { skills: {}, memory: {} }, loadError: null })
    },
    refsync: {
      get: vi.fn().mockResolvedValue(refPayload),
      onChanged: vi.fn(() => () => {}),
      searchRefs: vi.fn().mockResolvedValue([]),
      readRef: vi.fn().mockResolvedValue({ file: 'team-tips.md', content: '# Team tips\n' })
    },
    openExternal: vi.fn()
  }
}

let argus: ReturnType<typeof mockArgus>

beforeEach(() => {
  referenceSyncStore.reset()
  argus = mockArgus()
  ;(window as unknown as { argus: unknown }).argus = argus
  vi.mocked(confirm).mockResolvedValue(true)
})

describe('LibraryPage filters', () => {
  it('kind filter narrows to skills or references; initialKind presets it', async () => {
    render(<LibraryPage initialKind="reference" />)
    await screen.findByText('team-tips.md')
    expect(screen.getByRole('button', { name: 'Filter kind · reference' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.queryByText('rca')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Filter kind · skill' }))
    expect(await screen.findByText('rca')).toBeInTheDocument()
    expect(screen.queryByText('team-tips.md')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Filter kind · all' }))
    expect(await screen.findByText('team-tips.md')).toBeInTheDocument()
  })

  it('collapsing a group hides its rows; an active filter overrides collapse', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle section · User' }))
    expect(screen.queryByText('rca')).toBeNull()
    expect(screen.getByText('hive-probe')).toBeInTheDocument() // other groups untouched
    // search overrides collapse so matches can't hide
    fireEvent.change(screen.getByLabelText('search library'), { target: { value: 'rca' } })
    expect(await screen.findByText('rca')).toBeInTheDocument()
    // clearing restores the collapsed state
    fireEvent.change(screen.getByLabelText('search library'), { target: { value: '' } })
    await waitFor(() => expect(screen.queryByText('rca')).toBeNull())
    // a kind filter also overrides
    fireEvent.click(screen.getByRole('button', { name: 'Filter kind · skill' }))
    expect(await screen.findByText('rca')).toBeInTheDocument()
  })

  it('tier chip row is gone', async () => {
    render(<LibraryPage />)
    await screen.findByText('rca')
    expect(screen.queryByRole('button', { name: 'Filter tier · confluence' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Filter tier · all' })).toBeNull()
  })

  it('search matches skills by name client-side and references via refsync search IPC', async () => {
    argus.refsync.searchRefs.mockResolvedValue(['nav-runbook.md'])
    render(<LibraryPage />)
    await screen.findByText('rca')
    fireEvent.change(screen.getByLabelText('search library'), { target: { value: 'nav' } })
    await waitFor(() => expect(argus.refsync.searchRefs).toHaveBeenCalledWith('nav'))
    expect(await screen.findByText('nav-runbook.md')).toBeInTheDocument()
    expect(screen.queryByText('team-tips.md')).toBeNull()
    expect(screen.queryByText('my-notes')).toBeNull()
    // 'rca' does not contain 'nav' → hidden; but a skill name match survives
    fireEvent.change(screen.getByLabelText('search library'), { target: { value: 'rca' } })
    expect(await screen.findByText('rca')).toBeInTheDocument()
  })

  it('clearing the search restores the unfiltered list without another IPC call', async () => {
    argus.refsync.searchRefs.mockResolvedValue(['nav-runbook.md'])
    render(<LibraryPage />)
    await screen.findByText('rca')
    fireEvent.change(screen.getByLabelText('search library'), { target: { value: 'nav' } })
    await waitFor(() => expect(argus.refsync.searchRefs).toHaveBeenCalledWith('nav'))
    expect(await screen.findByText('nav-runbook.md')).toBeInTheDocument()
    expect(screen.queryByText('rca')).toBeNull()

    fireEvent.change(screen.getByLabelText('search library'), { target: { value: '' } })
    expect(await screen.findByText('rca')).toBeInTheDocument()
    expect(screen.getByText('team-tips.md')).toBeInTheDocument()
    expect(screen.getByText('my-notes')).toBeInTheDocument()
    // let the 200ms debounce window elapse — a regression would fire searchRefs('')
    await new Promise((r) => setTimeout(r, 250))
    expect(argus.refsync.searchRefs).toHaveBeenCalledTimes(1)
  })

  it('everything filtered out shows a no-matches line', async () => {
    argus.refsync.searchRefs.mockResolvedValue([])
    render(<LibraryPage />)
    await screen.findByText('rca')
    fireEvent.change(screen.getByLabelText('search library'), { target: { value: 'zzz' } })
    expect(await screen.findByText('No matches.')).toBeInTheDocument()
  })
})
