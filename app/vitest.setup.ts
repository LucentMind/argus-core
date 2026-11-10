import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { afterAll, beforeEach } from 'vitest'

import {
  createSqliteHandleTracker,
  type SqliteHandleTracker
} from './src/main/__tests__/helpers/sqliteHandles'
import { createTmpTracker, type TmpTracker } from './src/main/__tests__/helpers/tmpTracker'

// A developer machine may have ARGUS_PACKS_DIR/ARGUS_PACKS_SRC set in its ambient
// environment (e.g. to point a locally-run dev build at a stable packs location).
// packsDir()/seededPacksDir() (src/main/services/packs/paths.ts) treat those as
// unconditional overrides, so any leaked value silently redirects packs tests that
// pass an isolated argusHome onto that same real, persistent directory instead —
// invisible when tests run serially, but a genuine cross-file race (shared writes to
// one real dir) once vitest's default file parallelism runs those tests concurrently.
beforeEach(() => {
  delete process.env.ARGUS_PACKS_DIR
  delete process.env.ARGUS_PACKS_SRC
})

// Temp-home janitor. Every `fs.mkdtempSync(path.join(os.tmpdir(), 'argus-…'))` a
// test file makes is recorded, every node:sqlite DatabaseSync it opens is recorded,
// and once the file finishes the handles are closed and the dirs removed — whether
// or not the file cleans up after itself (69 files never did, and the open handles
// made even a dutiful rmSync fail with EBUSY on Windows; see helpers/tmpTracker.ts).
//
// The patched objects (the fs module object, the node:sqlite module object) are
// process-wide, while this setup file is re-evaluated for every test file in the
// worker. The trackers therefore live on globalThis so a re-evaluation reuses them
// instead of stacking a fresh wrapper on top of the last one. Tests import the fs
// default object and the app imports `{ DatabaseSync }` from node:sqlite, so patching
// the module objects (plus syncBuiltinESMExports for the builtin) reaches them
// without any mock.
const JANITOR = Symbol.for('argus.test.janitor')
type Janitor = { tmp: TmpTracker; sqlite: SqliteHandleTracker }
const g = globalThis as typeof globalThis & { [JANITOR]?: Janitor }
if (!g[JANITOR]) {
  const require = createRequire(import.meta.url)
  const sqlite = createSqliteHandleTracker(require('node:sqlite'), syncBuiltinESMExports)
  const tmp = createTmpTracker(fs)
  sqlite.install()
  tmp.install()
  g[JANITOR] = { tmp, sqlite }
}
const janitor = g[JANITOR]

afterAll(() => {
  janitor.sqlite.closeAll()
  janitor.tmp.cleanup()
})
