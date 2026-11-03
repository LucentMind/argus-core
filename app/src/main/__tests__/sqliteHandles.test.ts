import { describe, expect, it, vi } from 'vitest'

import { createSqliteHandleTracker } from './helpers/sqliteHandles'

// A stand-in for node:sqlite's DatabaseSync (DI): the tracker is installed on a
// fake module object, never on the real builtin, which already carries the
// suite-wide tracker from vitest.setup.ts.
class FakeDatabaseSync {
  static instances = 0
  isOpen = true
  readonly file: string
  constructor(file: string) {
    this.file = file
    FakeDatabaseSync.instances++
  }
  close(): void {
    if (!this.isOpen) throw Object.assign(new Error('closed'), { code: 'ERR_INVALID_STATE' })
    this.isOpen = false
  }
}

function fakeModule(): { DatabaseSync: typeof FakeDatabaseSync } {
  return { DatabaseSync: FakeDatabaseSync }
}

describe('createSqliteHandleTracker', () => {
  it('records every handle constructed through the patched export', () => {
    const mod = fakeModule()
    const tracker = createSqliteHandleTracker(mod)
    tracker.install()

    const a = new mod.DatabaseSync('a.db')
    const b = new mod.DatabaseSync('b.db')

    expect(tracker.handles.size).toBe(2)
    expect([...tracker.handles]).toEqual([a, b])
    expect(a).toBeInstanceOf(FakeDatabaseSync)
    expect(a).toBeInstanceOf(mod.DatabaseSync)
    expect(a.file).toBe('a.db')
  })

  it('closeAll closes the open handles, skips closed ones, and drains the set', () => {
    const mod = fakeModule()
    const tracker = createSqliteHandleTracker(mod)
    tracker.install()

    const open1 = new mod.DatabaseSync('1.db')
    const closedByTest = new mod.DatabaseSync('2.db')
    const open2 = new mod.DatabaseSync('3.db')
    closedByTest.close()

    expect(tracker.closeAll()).toBe(2)
    expect(open1.isOpen).toBe(false)
    expect(open2.isOpen).toBe(false)
    expect(tracker.handles.size).toBe(0)
  })

  it('closeAll keeps going when one close throws', () => {
    const mod = fakeModule()
    const tracker = createSqliteHandleTracker(mod)
    tracker.install()

    const bad = new mod.DatabaseSync('bad.db')
    const good = new mod.DatabaseSync('good.db')
    bad.close = () => {
      throw new Error('boom')
    }

    expect(() => tracker.closeAll()).not.toThrow()
    expect(good.isOpen).toBe(false)
    expect(tracker.handles.size).toBe(0)
  })

  it('calls onPatch after install so the caller can re-sync ESM bindings', () => {
    const mod = fakeModule()
    const onPatch = vi.fn()
    const tracker = createSqliteHandleTracker(mod, onPatch)
    expect(onPatch).not.toHaveBeenCalled()
    tracker.install()
    expect(onPatch).toHaveBeenCalledTimes(1)
    tracker.uninstall()
    expect(onPatch).toHaveBeenCalledTimes(2)
  })

  it('install is idempotent and uninstall restores the original class', () => {
    const mod = fakeModule()
    const tracker = createSqliteHandleTracker(mod)
    tracker.install()
    const patched = mod.DatabaseSync
    tracker.install()
    expect(mod.DatabaseSync).toBe(patched)
    expect(mod.DatabaseSync).not.toBe(FakeDatabaseSync)
    tracker.uninstall()
    expect(mod.DatabaseSync).toBe(FakeDatabaseSync)
  })

  it('static members still pass through the patched export', () => {
    const mod = fakeModule()
    const tracker = createSqliteHandleTracker(mod)
    tracker.install()
    const before = FakeDatabaseSync.instances
    new mod.DatabaseSync('x.db')
    expect(mod.DatabaseSync.instances).toBe(before + 1)
  })
})
