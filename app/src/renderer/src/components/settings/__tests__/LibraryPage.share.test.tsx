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

const refPayload: RefSyncPayload = {
  config: { spaces: [] } as unknown as RefSyncPayload['config'],
  loadError: null,
  cards: [],
  references: [
    {
      file: 'glossary.md',
      tier: 'team-knowledge',
      lastSynced: null,
      sourceCount: 0,
      stale: false
    },
    {
      file: 'routing-flow.md',
      tier: 'confluence',
      lastSynced: '2026-06-01T00:00:00.000Z',
      sourceCount: 2,
      stale: true
    }
  ]
}

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
    access: {
      patch: vi.fn().mockResolvedValue({ access: { skills: {}, memory: {} }, loadError: null })
    },
    hivemind: {
      get: vi.fn().mockResolvedValue(
        hivePayload({
          'skill/my-notes': {
            prUrl: 'https://github.com/acme/hivemind/pull/9',
            pushedAt: '2026-07-22T10:00:00.000Z'
          },
          'reference/glossary.md': {
            prUrl: 'https://github.com/acme/hivemind/pull/21',
            pushedAt: '2026-07-22T10:00:00.000Z'
          }
        })
      ),
      pushPreview: vi.fn().mockResolvedValue('# rca'),
      push: vi
        .fn()
        .mockResolvedValue({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/12' })
    },
    sourceControl: { status: vi.fn().mockResolvedValue(ghOk) },
    refsync: {
      get: vi.fn().mockResolvedValue(refPayload),
      onChanged: vi.fn(() => () => {}),
      searchRefs: vi.fn().mockResolvedValue([]),
      readRef: vi.fn().mockResolvedValue({ file: 'glossary.md', content: '# Glossary\n' })
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

describe('LibraryPage skill share-in-place', () => {
  it('user-tier rows get a Share button (enabled when repo + gh are ready); other tiers do not', async () => {
    render(<LibraryPage />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    await waitFor(() => expect(share).not.toBeDisabled())
    expect(screen.getByRole('button', { name: 'Share my-notes to HiveMind' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Share hive-probe to HiveMind' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Share analyze-applog to HiveMind' })
    ).not.toBeInTheDocument()
  })

  it('Share is disabled with a HiveMind pointer when gh is not authenticated', async () => {
    argus.sourceControl.status = vi
      .fn()
      .mockResolvedValue({ ...ghOk, installed: false, authenticated: false })
    render(<LibraryPage />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    expect(share).toBeDisabled()
    expect(share).toHaveAttribute(
      'title',
      expect.stringMatching(/needs a configured HiveMind repo/)
    )
  })

  it('Share is disabled when no HiveMind repo is configured', async () => {
    argus.hivemind.get = vi.fn().mockResolvedValue({
      repo: '',
      state: 'dormant',
      error: null,
      headCommit: null,
      lastSynced: null,
      items: [],
      pushable: [],
      pushes: {}
    })
    render(<LibraryPage />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    expect(share).toBeDisabled()
  })

  it('Share opens the push dialog inline; push links the PR; closing refetches receipts', async () => {
    render(<LibraryPage />)
    const share = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    await waitFor(() => expect(share).not.toBeDisabled())
    fireEvent.click(share)
    expect(await screen.findByText('# rca')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    await waitFor(() => expect(argus.hivemind.push).toHaveBeenCalledWith('skill', 'rca', 'Add rca'))
    expect(await screen.findByRole('button', { name: /pull\/12/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(argus.hivemind.get).toHaveBeenCalledTimes(2))
  })

  it('a push receipt renders a PR chip that opens externally', async () => {
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open PR · my-notes' }))
    expect(argus.openExternal).toHaveBeenCalledWith('https://github.com/acme/hivemind/pull/9')
    expect(screen.queryByRole('button', { name: 'Open PR · rca' })).not.toBeInTheDocument()
  })

  it('Share buttons disable while any push is in flight; re-enable when it settles', async () => {
    let pushResolve: (v: unknown) => void
    const pushPromise = new Promise((resolve) => {
      pushResolve = resolve
    })
    argus.hivemind.push = vi.fn().mockReturnValue(pushPromise)
    render(<LibraryPage />)
    const shareRca = await screen.findByRole('button', { name: 'Share rca to HiveMind' })
    const shareNotes = screen.getByRole('button', { name: 'Share my-notes to HiveMind' })
    await waitFor(() => expect(shareRca).not.toBeDisabled())
    // Click Share on rca and start the push
    fireEvent.click(shareRca)
    expect(await screen.findByText('# rca')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    // While push is in flight, my-notes Share button should be disabled
    await waitFor(() => expect(shareNotes).toBeDisabled())
    // Resolve the push
    pushResolve!({ ok: true, prUrl: 'https://github.com/acme/hivemind/pull/12' })
    // After push settles, my-notes Share button should re-enable
    await waitFor(() => expect(shareNotes).not.toBeDisabled())
  })
})

describe('LibraryPage reference share-in-place', () => {
  it('pushable-tier reference rows get a Share button; hive-managed tiers do not', async () => {
    render(<LibraryPage />)
    const share = await screen.findByRole('button', { name: 'Share glossary.md to HiveMind' })
    await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('button', { name: 'Share routing-flow.md to HiveMind' })).toBeNull()
  })

  it('Share is disabled with a HiveMind pointer when gh is missing', async () => {
    argus.sourceControl.status = vi.fn().mockResolvedValue({
      installed: false,
      version: null,
      authenticated: false,
      login: null,
      detail: ''
    })
    render(<LibraryPage />)
    const share = (await screen.findByRole('button', {
      name: 'Share glossary.md to HiveMind'
    })) as HTMLButtonElement
    expect(share.disabled).toBe(true)
    expect(share.title).toMatch(/needs a configured HiveMind repo/)
  })

  it('Share opens the push dialog inline and pushes kind reference', async () => {
    argus.hivemind.pushPreview = vi.fn().mockResolvedValue('# glossary')
    render(<LibraryPage />)
    const share = await screen.findByRole('button', { name: 'Share glossary.md to HiveMind' })
    await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(share)
    expect(await screen.findByText('# glossary')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }))
    await waitFor(() =>
      expect(argus.hivemind.push).toHaveBeenCalledWith(
        'reference',
        'glossary.md',
        'Add glossary.md'
      )
    )
  })

  it('a push receipt renders a PR chip that opens externally; the row still opens the viewer', async () => {
    render(<LibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open PR · glossary.md' }))
    expect(argus.openExternal).toHaveBeenCalledWith('https://github.com/acme/hivemind/pull/21')
    expect(argus.refsync.readRef).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'open · glossary.md' }))
    await waitFor(() => expect(argus.refsync.readRef).toHaveBeenCalledWith('glossary.md'))
  })
})
