// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { autonomyStore } from '../autonomyStore'
import type { AutonomyPayload } from '../../../../shared/autonomy'

const payload = (unacked: number): AutonomyPayload => ({
  contractVersion: 1,
  argusVersion: 'test',
  instanceId: 'i',
  windowDays: 30,
  lanes: [],
  unackedDemotions: unacked,
  timeInTriage: { medianMs: null, p90Ms: null, cases: 0 },
  costPerResolvedCaseUsd: null,
  resolvedCases: 0
})

describe('autonomyStore', () => {
  let onChangedCb: (() => void) | null = null
  beforeEach(() => {
    autonomyStore.reset()
    onChangedCb = null
    ;(window as unknown as { argus: unknown }).argus = {
      autonomy: {
        status: vi.fn().mockResolvedValue(payload(0)),
        onChanged: vi.fn((cb: () => void) => {
          onChangedCb = cb
          return () => undefined
        })
      }
    }
  })

  it('primes from status() and refetches on the changed broadcast', async () => {
    autonomyStore.start()
    await vi.waitFor(() => expect(autonomyStore.get()?.unackedDemotions).toBe(0))
    ;(window.argus.autonomy.status as ReturnType<typeof vi.fn>).mockResolvedValue(payload(2))
    onChangedCb!()
    await vi.waitFor(() => expect(autonomyStore.get()?.unackedDemotions).toBe(2))
  })

  it('start is idempotent', async () => {
    autonomyStore.start()
    autonomyStore.start()
    await vi.waitFor(() => expect(autonomyStore.get()).not.toBeNull())
    expect(window.argus.autonomy.status).toHaveBeenCalledTimes(1)
  })

  it('refresh() re-fetches when started, and is a no-op otherwise', async () => {
    autonomyStore.refresh() // not started yet — must not call status()
    expect(window.argus.autonomy.status).not.toHaveBeenCalled()

    autonomyStore.start()
    await vi.waitFor(() => expect(autonomyStore.get()?.unackedDemotions).toBe(0))
    ;(window.argus.autonomy.status as ReturnType<typeof vi.fn>).mockResolvedValue(payload(3))
    autonomyStore.refresh()
    await vi.waitFor(() => expect(autonomyStore.get()?.unackedDemotions).toBe(3))
  })
})
