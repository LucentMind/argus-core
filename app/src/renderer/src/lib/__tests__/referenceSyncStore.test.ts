// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest'
import { referenceSyncStore } from '../referenceSyncStore'
import type { RefSyncPayload } from '../../../../shared/referenceSync'

const payload = (over: Partial<RefSyncPayload> = {}): RefSyncPayload => ({
  config: { spaces: [], outdatedWindowMonths: 12, mustKeep: {} },
  loadError: null,
  cards: [],
  references: [],
  ...over
})

let onChanged: (p: RefSyncPayload) => void

beforeEach(() => {
  referenceSyncStore.reset()
  ;(window as unknown as { argus: unknown }).argus = {
    refsync: {
      get: vi.fn(async () => payload()),
      onChanged: vi.fn((cb: (p: RefSyncPayload) => void) => {
        onChanged = cb
        return () => undefined
      })
    }
  }
})

it('start() loads the payload and mirrors change broadcasts', async () => {
  referenceSyncStore.start()
  await vi.waitFor(() => expect(referenceSyncStore.get()).not.toBeNull())
  expect(referenceSyncStore.get()?.config.outdatedWindowMonths).toBe(12)
  onChanged(payload({ loadError: 'boom' }))
  expect(referenceSyncStore.get()?.loadError).toBe('boom')
})
