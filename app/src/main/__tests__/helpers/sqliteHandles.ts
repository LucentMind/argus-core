/**
 * Suite-wide SQLite handle janitor, the other half of tmpTracker.
 *
 * Removing a test's temp home is impossible on Windows while any file in it is
 * open, and most test files `openDb(path.join(home, 'argus.db'))` in a
 * beforeEach and never close it, so a plain afterAll `rmSync` fails with EBUSY
 * and leaves the whole directory behind (argus.db, -wal, -shm, case files).
 *
 * `install()` replaces `DatabaseSync` on the given module object with a Proxy
 * whose construct trap records every instance. node:sqlite is a builtin, so the
 * caller passes `syncBuiltinESMExports` as `onPatch` to push the replacement
 * into the live `import { DatabaseSync } from 'node:sqlite'` bindings the app
 * code uses. `closeAll()` closes whatever is still open, best-effort, so the
 * temp dirs can then be removed. vitest.setup.ts runs it in afterAll before the
 * tmp tracker's cleanup.
 */
export interface SqliteHandle {
  readonly isOpen: boolean
  close(): void
}

type HandleCtor = new (...args: never[]) => SqliteHandle

export interface SqliteHandleTracker {
  /** Handles constructed through the patched export since install or the last closeAll. */
  readonly handles: Set<SqliteHandle>
  install(): void
  uninstall(): void
  /** Closes every still-open tracked handle, swallowing errors; returns how many it closed. */
  closeAll(): number
}

export function createSqliteHandleTracker<M extends { DatabaseSync: HandleCtor }>(
  mod: M,
  onPatch: () => void = () => {}
): SqliteHandleTracker {
  const handles = new Set<SqliteHandle>()
  let original: M['DatabaseSync'] | null = null

  return {
    handles,
    install() {
      if (original) return
      original = mod.DatabaseSync
      mod.DatabaseSync = new Proxy(original, {
        construct(target, args) {
          // newTarget stays `target` so instances get the real prototype chain;
          // `instanceof` against the Proxy still holds because the Proxy
          // forwards the `prototype` read to the target.
          const db = Reflect.construct(target, args, target) as SqliteHandle
          handles.add(db)
          return db
        }
      }) as M['DatabaseSync']
      onPatch()
    },
    uninstall() {
      if (!original) return
      mod.DatabaseSync = original
      original = null
      onPatch()
    },
    closeAll() {
      let closed = 0
      for (const db of handles) {
        try {
          if (db.isOpen) {
            db.close()
            closed++
          }
        } catch {
          // A handle that refuses to close keeps its dir alive; that is the
          // tmp tracker's (swallowed) problem, never this file's failure.
        }
      }
      handles.clear()
      return closed
    }
  }
}
