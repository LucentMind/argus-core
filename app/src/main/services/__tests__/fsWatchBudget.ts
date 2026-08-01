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

/**
 * Gap between pokes in {@link armFsWatch}.
 *
 * Must stay ABOVE the widest watcher debounce in the codebase (300ms, in `caseWatch.ts` and
 * `proposalsWatch.ts`; `fileStore.ts` uses 200ms). Poking faster than the debounce window would
 * reset the timer on every poke and the callback would never fire at all — the poll would defeat
 * the very thing it is waiting for.
 */
const FS_WATCH_POLL_MS = 600

/** Long enough for a 300ms debounce to land, so a caller's `mockClear()` cannot race a
 *  callback that was already in flight when the watcher first fired. */
const DEBOUNCE_SETTLE_MS = 500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Poke the filesystem until an `fs.watch` watcher demonstrably fires, then let its debounce settle.
 *
 * **Why this exists.** On macOS `fs.watch` returns before its FSEvents stream is actually armed —
 * arming happens on a background thread. A write issued immediately after the call can therefore be
 * missed *entirely*: no event is ever delivered, and no amount of waiting produces one. That is the
 * shape of the flake this suite kept hitting, and it explains why three successive budget raises
 * (3s → 10s → CI-conditional 45s) never fixed it. A bigger timeout can rescue a *late* event; it can
 * do nothing for a *lost* one. Windows is unaffected because `ReadDirectoryChangesW` is armed
 * synchronously before `fs.watch` returns, which is why this only ever failed on macOS.
 *
 * Call this once after creating a watcher, then `mockClear()` the spy and make the real assertion
 * with a single write. A lost first event then costs one poll interval instead of the whole test.
 *
 * The returned poke count is the diagnostic: a run that needed more than one poke says so in the
 * log, so CI reports whether the first event was lost rather than leaving it inferred.
 *
 * NOTE: `caseWatch.test.ts`, `connectors.test.ts` and `fileStore.test.ts` have the same
 * write-immediately-after-watch shape and so the same latent race. They have not been observed
 * failing, so they are deliberately left alone — this helper is here for them when they are.
 *
 * @param poke   Touch the watched tree. Called repeatedly, so point it at a throwaway path rather
 *               than the file the test is actually about.
 * @param fired  Whether the watcher has been observed firing yet.
 * @returns      How many pokes it took.
 */
export async function armFsWatch(poke: () => void, fired: () => boolean): Promise<number> {
  const started = Date.now()
  const deadline = started + FS_WATCH_TIMEOUT
  let pokes = 0
  while (Date.now() < deadline) {
    poke()
    pokes++
    const until = Date.now() + FS_WATCH_POLL_MS
    while (Date.now() < until) {
      if (fired()) {
        const armedMs = Date.now() - started
        // Always logged, both platforms, so the numbers can be compared rather than argued
        // about. `pokes > 1` is the strong form of the diagnosis (the first event was lost
        // outright); a single poke with a long `armedMs` is the weak form (it was merely
        // late). Both are macOS-only predictions — Windows should read 1 poke, ~debounce ms.
        console.warn(`[fsWatchBudget] armed after ${pokes} poke(s), ${armedMs}ms`)
        await sleep(DEBOUNCE_SETTLE_MS)
        return pokes
      }
      await sleep(25)
    }
  }
  throw new Error(
    `fs.watch never fired after ${pokes} pokes over ${FS_WATCH_TIMEOUT}ms — ` +
      `the watcher is dead, not merely slow`
  )
}
