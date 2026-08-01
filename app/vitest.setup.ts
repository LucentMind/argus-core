import { beforeEach } from 'vitest'

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
