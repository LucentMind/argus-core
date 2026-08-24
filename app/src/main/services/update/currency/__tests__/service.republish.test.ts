import { describe, it, expect } from 'vitest'
import { CurrencyService } from '../service'
import { CurrencyAnchorStore } from '../anchors'
import { createAutoChangeWatcher } from '../autoChangeWatcher'

function memStore(): { load: () => { data: unknown; error: null }; write: (o: unknown) => void } {
  let data: unknown = {}
  return {
    load: () => ({ data, error: null }),
    write: (o: unknown) => {
      data = JSON.parse(JSON.stringify(o))
    }
  }
}

/**
 * Critical 1, whole-branch review: `payload().auto` is evaluated fresh inside `publish()`, but
 * NOTHING called `publish()` when only `settings.updates.auto` changed — surveys and applies are
 * the only publishers. A user who turned auto-update off kept seeing the TopBar badge and the
 * Sources/Team nav dots from the LAST payload, which still said `auto: true`, until the next
 * scheduled survey (up to 6h later, and never if auto is now off) or a restart.
 *
 * `republish()` is the fix's testable half: a caller (the `createAutoChangeWatcher` wiring in
 * `main/index.ts`) can now force a fresh payload out without waiting for a survey or an apply.
 * These tests wire `republish()` to a real `createAutoChangeWatcher` the same way `main/index.ts`
 * does, and assert the broadcast a subscriber (the renderer's `currencyStore`) actually receives —
 * this is the test the plan never wrote: every other renderer test on this branch stubs a payload
 * whose `auto` already matches the scenario, so nothing ever watched two copies of one fact
 * (the settings toggle and the payload's `auto`) disagree. Deleting `republish()`'s body, or
 * dropping the watcher wiring in `main/index.ts`, reproduces the exact stuck-badge bug this proves
 * against.
 */
describe('CurrencyService.republish', () => {
  it('re-publishes the current payload, including a fresh auto value, with no survey in between', () => {
    let auto = true
    const svc = new CurrencyService({
      adapters: [],
      anchors: new CurrencyAnchorStore(memStore()),
      autoEnabled: () => auto,
      isQuiet: () => true
    })
    const seen: boolean[] = []
    svc.subscribe((p) => seen.push(p.auto))

    auto = false
    svc.republish()

    expect(seen).toEqual([false])
  })

  it('notifies subscribers on every call, even with no state change', () => {
    const svc = new CurrencyService({
      adapters: [],
      anchors: new CurrencyAnchorStore(memStore()),
      autoEnabled: () => true,
      isQuiet: () => true
    })
    let calls = 0
    svc.subscribe(() => calls++)
    svc.republish()
    svc.republish()
    expect(calls).toBe(2)
  })

  it('wired through createAutoChangeWatcher, broadcasts auto:false the moment the setting flips off', () => {
    // Models the actual failure scenario: a settings object the user's toggle mutates directly,
    // a settingsService-style subscribe list, and the SAME wiring main/index.ts uses — a watcher
    // that calls svc.republish() only when updates.auto actually changes.
    const settings = { updates: { auto: true } }
    const settingsListeners: Array<() => void> = []
    const settingsService = {
      get: () => settings,
      subscribe: (cb: () => void) => settingsListeners.push(cb)
    }

    const svc = new CurrencyService({
      adapters: [],
      anchors: new CurrencyAnchorStore(memStore()),
      autoEnabled: () => settingsService.get().updates.auto,
      isQuiet: () => true
    })

    const watcher = createAutoChangeWatcher({
      getAuto: () => settingsService.get().updates.auto,
      onChange: () => svc.republish()
    })
    settingsService.subscribe(() => watcher.check())

    const broadcasts: boolean[] = []
    svc.subscribe((p) => broadcasts.push(p.auto))

    // The user flips "Keep everything up to date" off. Nothing surveys, nothing applies — only
    // the setting changes and the settings service notifies its subscribers, exactly as
    // settingsStore.set() does in the real app.
    settings.updates.auto = false
    for (const cb of settingsListeners) cb()

    expect(broadcasts).toEqual([false])
  })
})
