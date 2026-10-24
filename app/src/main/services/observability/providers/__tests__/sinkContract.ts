import { describe, it, expect } from 'vitest'
import type { ObservationSink } from '../../sink'
import type { ObservationIntent } from '../../intent'

export interface ContractHarness {
  sink: ObservationSink
  /** Resolve any deferred ids and let pending work land. */
  settle: () => Promise<void>
  /** From now on (permanently), make the backend throw on every call. */
  backendThrows: () => void
  recorded: () => {
    roots: number
    /** Non-root observations/spans whose parent is the root for CONTRACT_SEED. */
    childrenOfRoot: number
    /** Backend start/observation calls, counted BEFORE the backend accepts or rejects them. */
    attempts: number
    scoresForSeed: (seed: string) => number
    containsText: (s: string) => boolean
  }
}

export const CONTRACT_SEED = 'argus-session-77'
export const CONTRACT_SCRIPT: ObservationIntent[] = [
  {
    kind: 'trace-root',
    seed: CONTRACT_SEED,
    name: 'case-x · session 77',
    caseSlug: 'case-x',
    metadata: { caseId: 1 }
  },
  {
    kind: 'generation',
    seed: CONTRACT_SEED,
    name: 'turn',
    model: 'claude-sonnet-5',
    startTime: 1000,
    endTime: 2000,
    usage: { input: 10, output: 5 },
    costUsd: 0.01,
    input: 'CONTENT-IN',
    output: 'CONTENT-OUT'
  },
  {
    kind: 'tool',
    seed: CONTRACT_SEED,
    name: 'read_file',
    startTime: 1100,
    endTime: 1200,
    isError: false,
    output: 'CONTENT-TOOL'
  },
  { kind: 'event', seed: CONTRACT_SEED, name: 'session resumed' },
  { kind: 'score', seed: CONTRACT_SEED, name: 'hitl_approved', value: 1 },
  { kind: 'score', seed: 'argus-session-78', name: 'finding_accepted', value: 0 } // no root for this seed
]

/** Every adapter runs this. `make` builds a fresh sink + fake backend per test. */
export function describeSinkContract(
  label: string,
  make: (opts: { captureContent: boolean }) => ContractHarness
): void {
  describe(`${label} — ObservationSink contract`, () => {
    it('creates exactly one root per seed and attaches children and scores to it', async () => {
      const h = make({ captureContent: true })
      h.sink.emit(CONTRACT_SCRIPT)
      h.sink.emit([CONTRACT_SCRIPT[0]]) // duplicate root intent
      await h.settle()
      await h.sink.flush()
      const r = h.recorded()
      expect(r.roots).toBe(1)
      expect(r.childrenOfRoot).toBe(3) // generation + tool + event
      expect(r.scoresForSeed(CONTRACT_SEED)).toBe(1)
      expect(r.scoresForSeed('argus-session-78')).toBe(1)
    })

    it('never throws from emit when the backend throws, and flush still settles', async () => {
      const h = make({ captureContent: true })
      h.backendThrows()
      expect(() => h.sink.emit(CONTRACT_SCRIPT)).not.toThrow()
      await expect(h.sink.flush()).resolves.toBeUndefined()
      // The contract requires lastError (optional only on the interface, for test fakes).
      expect(h.sink.lastError?.()).toBeTruthy()
    })

    it('sends content only when captureContent is on', async () => {
      const on = make({ captureContent: true })
      on.sink.emit(CONTRACT_SCRIPT)
      await on.settle()
      await on.sink.flush()
      expect(on.recorded().containsText('CONTENT-IN')).toBe(true)
      expect(on.recorded().containsText('CONTENT-OUT')).toBe(true)
      expect(on.recorded().containsText('CONTENT-TOOL')).toBe(true)

      const off = make({ captureContent: false })
      off.sink.emit(CONTRACT_SCRIPT)
      await off.settle()
      await off.sink.flush()
      expect(off.recorded().containsText('CONTENT-IN')).toBe(false)
      expect(off.recorded().containsText('CONTENT-OUT')).toBe(false)
      expect(off.recorded().containsText('CONTENT-TOOL')).toBe(false)
    })

    it('shutdown is idempotent and emit after shutdown is a no-op', async () => {
      const h = make({ captureContent: true })
      // Positive control, not a baseline: proves the harness records at all, so the
      // post-shutdown assertions below cannot pass merely because nothing is ever recorded.
      h.sink.emit(CONTRACT_SCRIPT)
      await h.settle()
      await h.sink.flush()
      expect(h.recorded().roots).toBe(1)
      const attemptsBefore = h.recorded().attempts

      await h.sink.shutdown()
      await h.sink.shutdown()

      h.sink.emit(CONTRACT_SCRIPT)
      await h.settle()
      // A stopped sink may resolve or reject its flush; tolerate both.
      await h.sink.flush().catch(() => {})

      expect(h.recorded().roots).toBe(1)
      // The sink itself must not reach the backend after shutdown (a backend that
      // rejects late spans would otherwise mask a sink that ignores `stopped`).
      expect(h.recorded().attempts).toBe(attemptsBefore)
    })
  })
}
