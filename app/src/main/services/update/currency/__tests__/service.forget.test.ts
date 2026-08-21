import { describe, it, expect, vi } from 'vitest'
import { CurrencyService } from '../service'
import { CurrencyAnchorStore } from '../anchors'
import type { CurrencyAdapter } from '../adapter'
import type { Candidate } from '../../../../../shared/currency'

const SIX_H = 21_600_000

function memStore(): { load: () => { data: unknown; error: null }; write: (o: unknown) => void } {
  let data: unknown = {}
  return {
    load: () => ({ data, error: null }),
    write: (o: unknown) => {
      data = JSON.parse(JSON.stringify(o))
    }
  }
}

const localEditsBlocked: Candidate = {
  domain: 'hive-reference',
  key: 'reference/style.md',
  label: 'style.md',
  from: 'abc',
  to: 'def',
  verdict: 'blocked',
  reason: { kind: 'local-edits' }
}

// Deliberately NOT an 'auth' reason: that kind is withheld on its first sighting (the two-strike
// grace in `replaceBlockedFor`), which would make it absent after a single `surveyNow` for a
// reason unrelated to what this file is testing.
const otherBlocked: Candidate = {
  domain: 'pack',
  key: 'code-graph',
  label: 'Code Graph',
  from: '1.0.0',
  to: '1.0.0',
  verdict: 'blocked',
  reason: { kind: 'new-dependency' }
}

function build(adapters: CurrencyAdapter[] = []): CurrencyService {
  return new CurrencyService({
    adapters,
    anchors: new CurrencyAnchorStore(memStore()),
    autoEnabled: () => true,
    isQuiet: () => true,
    now: () => 0,
    tickMs: 1_000,
    intervalMs: SIX_H
  })
}

/**
 * Finding 2: `this.blocked` is only ever rewritten by a survey (`replaceBlockedFor`). The manual
 * apply/install IPC handlers never trigger one, so a hold a user has just resolved by hand (e.g.
 * "Update -> Overwrite my copy") kept reading as held back — badge, nav dot, reason line all
 * stuck — until the next scheduled survey up to 6h later. `forget` is the queryable escape hatch
 * those handlers call after a successful outcome.
 */
describe('CurrencyService.forget', () => {
  it('drops a matching blocked entry from the payload', async () => {
    const adapter: CurrencyAdapter = {
      id: 'hive',
      survey: vi.fn(async () => [localEditsBlocked]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build([adapter])
    // Populate `blocked` the only way the service itself ever does: a survey.
    await svc.surveyNow('hive')
    expect(svc.payload().blocked).toEqual([localEditsBlocked])

    svc.forget(localEditsBlocked.key)
    expect(svc.payload().blocked).toEqual([])
  })

  it('leaves other keys untouched', async () => {
    const hive: CurrencyAdapter = {
      id: 'hive',
      survey: vi.fn(async () => [localEditsBlocked]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const packs: CurrencyAdapter = {
      id: 'packs',
      survey: vi.fn(async () => [otherBlocked]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build([hive, packs])
    await svc.surveyNow('hive')
    await svc.surveyNow('packs')
    expect(svc.payload().blocked).toEqual(expect.arrayContaining([localEditsBlocked, otherBlocked]))

    svc.forget(localEditsBlocked.key)
    expect(svc.payload().blocked).toEqual([otherBlocked])
  })

  it('notifies subscribers so a live badge/reason-line clears immediately', async () => {
    const adapter: CurrencyAdapter = {
      id: 'hive',
      survey: vi.fn(async () => [localEditsBlocked]),
      apply: vi.fn(async () => ({ ok: true as const }))
    }
    const svc = build([adapter])
    await svc.surveyNow('hive')
    const seen: number[] = []
    svc.subscribe((p) => seen.push(p.blocked.length))
    svc.forget(localEditsBlocked.key)
    expect(seen).toEqual([0])
  })

  it('is a harmless no-op when the key is not held back', async () => {
    const svc = build([])
    expect(() => svc.forget('nothing/here')).not.toThrow()
    expect(svc.payload().blocked).toEqual([])
  })
})
