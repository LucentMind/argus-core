// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi, beforeEach } from 'vitest'
import { SpaceDialog } from '../references/SpaceDialog'
import { SyncReportView } from '../references/SyncReportView'
import { referenceSyncStore } from '../../lib/referenceSyncStore'
import type { TreeNodeVM, SyncReport } from '../../../../shared/referenceSync'

const root: TreeNodeVM = {
  id: '100',
  title: 'Home',
  version: 1,
  lastModified: null,
  hasChildren: false,
  isNew: false,
  outdated: false
}
const report: SyncReport = {
  syncId: 'sid',
  spaceKey: 'NAVNATIVE',
  selectedCount: 1,
  drafts: [
    {
      target: 'routing-flow.md',
      oldBody: 'old',
      newBody: 'new',
      guardMisses: ['BLOCKED_VERSION'],
      pages: [{ id: '100', title: 'Home', url: 'u', version: 1 }]
    }
  ],
  unrouted: [{ id: '102', title: 'Meeting notes' }],
  conflicts: [],
  failures: []
}

beforeEach(() => {
  referenceSyncStore.reset()
  ;(window as unknown as { argus: unknown }).argus = {
    packs: {
      referenceRouting: vi.fn(async () => [
        { keywords: ['binlog', 'automotive'], target: 'binlog-protocol.md' }
      ])
    },
    refsync: {
      get: vi.fn(async () => null),
      onChanged: vi.fn(() => () => undefined),
      onProgress: vi.fn(() => () => undefined),
      validateSpace: vi.fn(async () => ({
        ok: true,
        value: { space: { key: 'NAVNATIVE', name: 'Nav Native', homepageId: '100' }, root }
      })),
      children: vi.fn(async () => ({ ok: true, value: [] })),
      saveSpace: vi.fn(async () => ({
        config: { spaces: [], outdatedWindowMonths: 12 },
        loadError: null,
        cards: [],
        references: []
      })),
      sync: vi.fn(async () => ({ ok: true, value: report })),
      applyDrafts: vi.fn(async () => ({ written: ['routing-flow.md'], skipped: [] }))
    }
  }
})

it('add flow: validate → curate → save & sync → approve drafts', async () => {
  const onClose = vi.fn()
  render(<SpaceDialog onClose={onClose} />)
  // let the mount-time referenceRouting() fetch resolve before validating,
  // so the seed lands in the `validate` closure used by the click below
  await waitFor(() => expect(window.argus.packs.referenceRouting).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByRole('textbox', { name: 'space key' }), {
    target: { value: 'NAVNATIVE' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  expect(await screen.findByText('Home')).toBeTruthy() // curate step, tree root visible
  fireEvent.click(screen.getByRole('checkbox', { name: 'select · Home' })) // include root
  fireEvent.click(screen.getByRole('button', { name: 'Save & Sync' }))
  await waitFor(() =>
    expect(window.argus.refsync.saveSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'NAVNATIVE',
        includeRoots: ['100'],
        routingRules: [{ keywords: ['binlog', 'automotive'], target: 'binlog-protocol.md' }]
      })
    )
  )
  expect(await screen.findByText('routing-flow.md')).toBeTruthy() // report step
  expect(screen.getByText('Meeting notes')).toBeTruthy() // unrouted surfaced
  expect(screen.getByText(/BLOCKED_VERSION/)).toBeTruthy() // must-keep miss rendered
  fireEvent.click(screen.getByRole('button', { name: 'Apply 1 file' }))
  await waitFor(() =>
    expect(window.argus.refsync.applyDrafts).toHaveBeenCalledWith('sid', ['routing-flow.md'])
  )
})

it('SyncReportView surfaces a rejected applyDrafts as an alert instead of failing silently', async () => {
  ;(window.argus.refsync.applyDrafts as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('Sync report expired — run Sync again')
  )
  render(<SyncReportView report={report} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Apply 1 file' }))
  const message = await screen.findByText('Sync report expired — run Sync again')
  expect(message.getAttribute('role')).toBe('alert')
})

it('fetches reference-routing seeds once on mount and falls back to [] when empty', async () => {
  ;(window.argus.packs.referenceRouting as ReturnType<typeof vi.fn>).mockResolvedValue([])
  render(<SpaceDialog onClose={vi.fn()} />)
  await waitFor(() => expect(window.argus.packs.referenceRouting).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByRole('textbox', { name: 'space key' }), {
    target: { value: 'NAVNATIVE' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'select · Home' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(window.argus.refsync.saveSpace).toHaveBeenCalledWith(
      expect.objectContaining({ routingRules: [] })
    )
  )
})

it('validate failure shows the REST error inline (e.g. space not found)', async () => {
  ;(window.argus.refsync.validateSpace as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    code: 'not-found',
    message: 'Not found on Jira'
  })
  render(<SpaceDialog onClose={vi.fn()} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'space key' }), {
    target: { value: 'NOPE' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
})
