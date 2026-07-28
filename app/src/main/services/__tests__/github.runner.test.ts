import { describe, it, expect } from 'vitest'
import { defaultGhRunner, fetchJobLog, GH_LOG_MAX_BYTES, type Runner } from '../github'

/**
 * The one file in this suite that SPAWNS A REAL PROCESS, on purpose.
 *
 * Every other `gh` test injects a fake `Runner` that returns a string — which is why a real
 * defect survived a green suite: `defaultGhRunner` passed no `maxBuffer`, so Node's 1 MB default
 * applied and any job log over 1 MB died with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. The 2 MB
 * tail-truncation in `ciLogs.ts` was therefore unreachable: a log large enough to need truncating
 * always blew the buffer first. Found 2026-07-28 driving the packaged app against a real 3.08 MB
 * Actions log; no fake could have caught it, because a fake has no child process to buffer.
 *
 * These spawn `node` rather than `gh`: the subject is the runner's own spawn options, and binding
 * the regression test to an installed CLI and a network round trip would make it flaky for
 * reasons unrelated to what it asserts.
 */

/** Emit `n` bytes on stdout and exit 0. */
const emitBytes = (n: number): string[] => [
  '-e',
  `process.stdout.write('x'.repeat(${n})); process.stdout.write('\\n')`
]

describe('defaultGhRunner (real subprocess)', () => {
  it('survives stdout larger than node’s 1MB execFile default', async () => {
    const bytes = 3 * 1024 * 1024
    const out = await defaultGhRunner(process.execPath, emitBytes(bytes), { timeoutMs: 60_000 })
    // `.trim()` takes the trailing newline off; the payload itself must arrive whole.
    expect(out.length).toBe(bytes)
  }, 60_000)

  it('honours an explicit maxBytes ceiling by failing loudly, not by truncating', async () => {
    // A silently head-truncated log would be worse than an error: the failure a CI log exists to
    // show is at its END, so a quiet truncation would drop the very thing being looked for.
    await expect(
      defaultGhRunner(process.execPath, emitBytes(512 * 1024), {
        timeoutMs: 60_000,
        maxBytes: 64 * 1024
      })
    ).rejects.toThrow(/maxBuffer/i)
  }, 60_000)

  it('still returns small output trimmed, exactly as every other caller expects', async () => {
    const out = await defaultGhRunner(process.execPath, ['-e', "process.stdout.write('hi\\n')"], {
      timeoutMs: 30_000
    })
    expect(out).toBe('hi')
  }, 30_000)
})

describe('fetchJobLog', () => {
  it('asks for a ceiling far above the 2MB the caller keeps', async () => {
    // The whole body is buffered before `ciLogs.ts` tail-truncates it, so the fetch ceiling must
    // exceed CI_LOG_MAX_BYTES by a wide margin or truncation is unreachable again.
    let seen: { timeoutMs?: number; maxBytes?: number } | undefined
    const run: Runner = async (_cmd, _args, opts) => {
      seen = opts
      return 'log'
    }
    await fetchJobLog(run, 'acme/widget', 42)
    expect(seen?.maxBytes).toBe(GH_LOG_MAX_BYTES)
    expect(GH_LOG_MAX_BYTES).toBeGreaterThan(2 * 1024 * 1024)
  })
})
