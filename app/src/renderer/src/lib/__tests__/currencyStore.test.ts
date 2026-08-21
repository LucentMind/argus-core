// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { currencyStore, pageOwning } from '../currencyStore'
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
      }
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
})
