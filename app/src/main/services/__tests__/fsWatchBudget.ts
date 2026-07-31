/**
 * How long an `fs.watch`-driven `vi.waitFor` may wait, CI-conditional.
 *
 * Not a `.test.ts`, so vitest's `include` glob does not collect it as a suite.
 *
 * These waits are not measuring code — they are waiting on the OS to deliver a filesystem event.
 * That latency is unbounded in practice on a shared runner: macOS coalesces through FSEvents, and
 * a starved GitHub runner has pushed this suite from a ~380s baseline to 915s. `vitest.config.ts`
 * already concluded that "no fixed budget tuned to 'typical slow' survives that tail" and made
 * `testTimeout`/`hookTimeout` CI-conditional for exactly that reason; these per-call budgets were
 * the last ones left hard-coded, and they had already drifted apart (10s in two files, 15s in a
 * third) without anyone deciding they should differ.
 *
 * So: tight locally, where a watcher that never fires is a real regression and should fail fast;
 * wide in CI, where the only job is to fail a true hang. The CI value stays under
 * `testTimeout` (60s in CI) so a genuinely dead watcher still fails as an assertion here rather
 * than as an opaque test-level timeout.
 */
export const FS_WATCH_TIMEOUT = process.env.CI ? 45_000 : 10_000
