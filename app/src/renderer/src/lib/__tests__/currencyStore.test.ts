// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { currencyStore, pageOwning, needsYouLabel } from '../currencyStore'
import type { Candidate, CurrencyPayload } from '../../../../shared/currency'

const blocked = (domain: Candidate['domain'], kind: 'local-edits' | 'unsupported'): Candidate => ({
  domain,
  key: `${domain}-k`,
  label: 'x',
  from: '1',
  to: '2',
  verdict: 'blocked',
  reason: { kind }
})

function stubBridge(payload: CurrencyPayload): { emit: (p: CurrencyPayload) => void } {
  // Mirrors the real preload bridge (`app/src/preload/index.ts`'s `ipcRenderer.on`), which
  // registers an independent listener per call rather than a single slot — so a double `start()`
  // in the store under test actually attaches two listeners here, and a missing idempotence guard
  // shows up as a doubled notification count.
  const listeners = new Set<(p: CurrencyPayload) => void>()
  // @ts-expect-error test stub
  window.argus = {
    currency: {
      get: vi.fn(async () => payload),
      surveyNow: vi.fn(async () => {}),
      onChanged: (fn: (p: CurrencyPayload) => void) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
      onAdopted: vi.fn(() => () => {}),
      ackAdopted: vi.fn(async () => {}),
      pendingAdopted: vi.fn(async () => 0)
    }
  }
  return {
    emit: (p) => {
      for (const fn of listeners) fn(p)
    }
  }
}

const empty: CurrencyPayload = { auto: true, lastSurveyAt: null, blocked: [], busy: false }

describe('pageOwning', () => {
  it('maps each domain to the settings page that shows it', () => {
    expect(pageOwning('core')).toBe('general')
    expect(pageOwning('pack')).toBe('sources')
    expect(pageOwning('hive-skill')).toBe('team')
    expect(pageOwning('hive-reference')).toBe('team')
  })
})

describe('currencyStore', () => {
  beforeEach(() => currencyStore.reset())

  it('hydrates from the bridge on start', async () => {
    const payload = { ...empty, blocked: [blocked('pack', 'local-edits')] }
    stubBridge(payload)
    currencyStore.start()
    await vi.waitFor(() => expect(currencyStore.get().blocked).toHaveLength(1))
  })

  it('groups surfaced blocks by owning page', async () => {
    stubBridge({
      ...empty,
      blocked: [blocked('pack', 'local-edits'), blocked('hive-reference', 'local-edits')]
    })
    currencyStore.start()
    await vi.waitFor(() => expect(currencyStore.get().blocked).toHaveLength(2))
    const byPage = currencyStore.blockedByPage()
    expect(byPage.sources).toHaveLength(1)
    expect(byPage.team).toHaveLength(1)
    expect(byPage.general).toHaveLength(0)
  })

  it('never groups an unsupported block — it is not actionable', async () => {
    stubBridge({ ...empty, blocked: [blocked('core', 'unsupported')] })
    currencyStore.start()
    await vi.waitFor(() => expect(currencyStore.get().blocked).toHaveLength(1))
    expect(currencyStore.blockedByPage().general).toHaveLength(0)
    expect(currencyStore.surfacedCount()).toBe(0)
  })

  it('updates on a broadcast', async () => {
    const { emit } = stubBridge(empty)
    currencyStore.start()
    await vi.waitFor(() => expect(currencyStore.get()).toBeTruthy())
    emit({ ...empty, blocked: [blocked('hive-skill', 'local-edits')] })
    expect(currencyStore.blockedByPage().team).toHaveLength(1)
  })

  it('start() is idempotent — a second call adds no second subscription', async () => {
    const { emit } = stubBridge(empty)
    let notifications = 0
    currencyStore.subscribe(() => notifications++)
    currencyStore.start()
    currencyStore.start()
    await vi.waitFor(() => expect(currencyStore.get()).toBeTruthy())
    notifications = 0
    emit({ ...empty, blocked: [blocked('pack', 'local-edits')] })
    expect(notifications).toBe(1)
  })

  // Finding 6 (whole-branch review): `start()` registers `onChanged` BEFORE awaiting `get()`, so
  // a broadcast can arrive while hydration is still in flight. Without a guard, the later-
  // resolving (and by now stale) `get()` result overwrites whatever the broadcast just set.
  describe('start() hydration race', () => {
    it('does not let a late-resolving get() clobber a broadcast that arrived first', async () => {
      let resolveGet!: (p: CurrencyPayload) => void
      const listeners = new Set<(p: CurrencyPayload) => void>()
      // @ts-expect-error test stub
      window.argus = {
        currency: {
          get: vi.fn(
            () =>
              new Promise<CurrencyPayload>((resolve) => {
                resolveGet = resolve
              })
          ),
          surveyNow: vi.fn(async () => {}),
          onChanged: (fn: (p: CurrencyPayload) => void) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
          },
          onAdopted: vi.fn(() => () => {}),
          ackAdopted: vi.fn(async () => {}),
          pendingAdopted: vi.fn(async () => 0)
        }
      }
      currencyStore.start()
      const broadcast = { ...empty, blocked: [blocked('pack', 'local-edits')] }
      for (const fn of listeners) fn(broadcast)
      expect(currencyStore.get()).toEqual(broadcast)

      // The hydration resolves only now, AFTER the broadcast — its stale payload must not win.
      resolveGet({ ...empty, blocked: [] })
      await new Promise((r) => setTimeout(r, 0))
      expect(currencyStore.get()).toEqual(broadcast)
    })

    it('a rejected get() does not throw and leaves the store usable via a later broadcast', async () => {
      const listeners = new Set<(p: CurrencyPayload) => void>()
      // @ts-expect-error test stub
      window.argus = {
        currency: {
          get: vi.fn(async () => {
            throw new Error('offline')
          }),
          surveyNow: vi.fn(async () => {}),
          onChanged: (fn: (p: CurrencyPayload) => void) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
          },
          onAdopted: vi.fn(() => () => {}),
          ackAdopted: vi.fn(async () => {}),
          pendingAdopted: vi.fn(async () => 0)
        }
      }
      expect(() => currencyStore.start()).not.toThrow()
      // Let the rejected promise settle. If `start()` leaves it unhandled, vitest reports the run
      // itself as failed even though no assertion below would catch it.
      await new Promise((r) => setTimeout(r, 0))

      const broadcast = { ...empty, blocked: [blocked('hive-skill', 'local-edits')] }
      for (const fn of listeners) fn(broadcast)
      expect(currencyStore.get()).toEqual(broadcast)
    })
  })

  // Nested inside `describe('currencyStore')` (not a sibling) so it inherits that describe's
  // `beforeEach(() => currencyStore.reset())` above — a sibling describe would not run it, and
  // state would leak in from whichever test ran last.
  describe('auto-update off', () => {
    it('reports no global count — nothing may demand attention for a disabled service', async () => {
      stubBridge({ ...empty, auto: false, blocked: [blocked('pack', 'local-edits')] })
      currencyStore.start()
      await vi.waitFor(() => expect(currencyStore.get().blocked).toHaveLength(1))
      expect(currencyStore.surfacedCount()).toBe(0)
    })

    it('groups nothing by page', async () => {
      stubBridge({ ...empty, auto: false, blocked: [blocked('pack', 'local-edits')] })
      currencyStore.start()
      await vi.waitFor(() => expect(currencyStore.get().blocked).toHaveLength(1))
      const byPage = currencyStore.blockedByPage()
      expect(byPage.sources).toHaveLength(0)
      expect(byPage.general).toHaveLength(0)
      expect(byPage.team).toHaveLength(0)
    })

    it('leaves the raw payload alone — the pages still read it directly', async () => {
      stubBridge({ ...empty, auto: false, blocked: [blocked('pack', 'local-edits')] })
      currencyStore.start()
      await vi.waitFor(() => expect(currencyStore.get().blocked).toHaveLength(1))
      expect(currencyStore.get().blocked).toHaveLength(1)
    })

    it('still counts and groups when auto is on', async () => {
      stubBridge({ ...empty, auto: true, blocked: [blocked('pack', 'local-edits')] })
      currencyStore.start()
      await vi.waitFor(() => expect(currencyStore.get().blocked).toHaveLength(1))
      expect(currencyStore.surfacedCount()).toBe(1)
      expect(currencyStore.blockedByPage().sources).toHaveLength(1)
    })
  })
})

describe('needsYouLabel', () => {
  it('words the TopBar and nav-row shape — subject first, em dash', () => {
    expect(needsYouLabel(1, { subject: 'Settings' })).toBe('Settings — 1 update needs you')
    expect(needsYouLabel(2, { subject: 'Sources' })).toBe('Sources — 2 updates need you')
  })

  it('words the section-badge shape — qualifier inside the noun, no subject', () => {
    expect(needsYouLabel(1, { qualifier: 'pack' })).toBe('1 pack update needs you')
    expect(needsYouLabel(2, { qualifier: 'HiveMind' })).toBe('2 HiveMind updates need you')
  })

  it('agrees the verb with the noun in every shape', () => {
    expect(needsYouLabel(1)).toBe('1 update needs you')
    expect(needsYouLabel(2)).toBe('2 updates need you')
  })
})
