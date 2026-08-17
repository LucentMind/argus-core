import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { DistillQueue, reconcileAndEnqueue, needsDistillRun, TRAJECTORY_JSON_CAP } from '../queue'
import { DistillParseError } from '../contract'
import { DistillAgentRunError } from '../caseDistiller'
import type { CaseDistillInput, DistillStatusPayload } from '../../../../shared/distill'
import type { TrajectoryEntry } from '../../agent/driver'

const INPUT = { caseMeta: { slug: 'x' } } as unknown as CaseDistillInput

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

function makeQueue(over: Partial<ConstructorParameters<typeof DistillQueue>[0]> = {}): {
  q: DistillQueue
  broadcasts: unknown[]
} {
  const broadcasts: unknown[] = []
  const q = new DistillQueue({
    db,
    assembleInput: () => INPUT,
    distill: async () => ({ raw: '```json\n{}\n```', output: {} }),
    stage: () => ({ staged: 0, droppedDuplicates: 0, supersededRemoved: 0 }),
    broadcast: (p) => broadcasts.push(p),
    ...over
  })
  return { q, broadcasts }
}

describe('DistillQueue', () => {
  it('runs a job to done with itemCount 0 (nothing to distill)', async () => {
    const { q, broadcasts } = makeQueue()
    q.enqueue('case-a')
    await q.idle()
    const job = q.statusFor('case-a')!
    expect(job.state).toBe('done')
    expect(job.itemCount).toBe(0)
    expect(broadcasts.length).toBeGreaterThanOrEqual(2) // running + done at minimum
  })

  it('parse failure → failed with raw preserved; retry re-runs from same snapshot', async () => {
    let calls = 0
    const { q } = makeQueue({
      distill: async () => {
        calls++
        if (calls === 1) throw new DistillParseError('bad', 'RAW TEXT')
        return { raw: '```json\n{}\n```', output: {} }
      }
    })
    q.enqueue('case-a')
    await q.idle()
    const failed = q.statusFor('case-a')!
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('bad')
    const row = db.prepare(`SELECT raw_output FROM distill_jobs WHERE id = ?`).get(failed.id) as {
      raw_output: string
    }
    expect(row.raw_output).toBe('RAW TEXT')
    q.retry(failed.id)
    await q.idle()
    expect(q.statusFor('case-a')!.state).toBe('done')
  })

  it("retry() resets every v2 column to NULL, not just the v1 fields — a retried job must not carry the previous attempt's cost/turns/trajectory", async () => {
    const trajectory: TrajectoryEntry[] = [{ turn: 1, tool: 'x', argsSummary: '{}' }]
    const { q } = makeQueue({
      assembleInput: (slug) => ({ caseMeta: { slug } }) as unknown as CaseDistillInput,
      distill: async (input) => {
        const slug = (input as CaseDistillInput).caseMeta.slug
        if (slug === 'case-a') {
          throw new DistillAgentRunError(
            'budget exhausted (timeout) before a final answer',
            'STALE',
            {
              usage: { inputTokens: 9, outputTokens: 9, costUsd: 0.09, durationMs: 999 },
              turnCount: 12,
              toolCallCount: 11,
              trajectory,
              promptChars: 777
            }
          )
        }
        return new Promise(() => {}) // case-b (below) occupies the single in-flight slot forever
      }
    })
    q.enqueue('case-a')
    await q.idle()
    const failed = q.statusFor('case-a')!
    expect(failed.state).toBe('failed')
    expect(failed.costUsd).toBe(0.09) // sanity: the columns really were recorded pre-retry
    const preRetryRow = db
      .prepare(`SELECT trajectory_json FROM distill_jobs WHERE id = ?`)
      .get(failed.id) as { trajectory_json: string | null }
    expect(preRetryRow.trajectory_json).not.toBeNull()

    // Occupy the queue's single in-flight slot with an unrelated, never-resolving job BEFORE
    // retrying — this queue processes one job at a time regardless of slug (see the class doc
    // comment), so with the slot held, retry()'s kick() call no-ops and the retried row is
    // guaranteed to still read state='queued' below, rather than racing kick()'s own loop
    // (which runs synchronously far enough to flip state to 'running' before retry() returns).
    q.enqueue('case-b')
    await vi.waitFor(() => expect(q.statusFor('case-b')!.state).toBe('running'), {
      timeout: 5000
    })

    q.retry(failed.id)
    const row = db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(failed.id) as Record<
      string,
      unknown
    >
    expect(row.state).toBe('queued')
    expect(row.error).toBeNull()
    expect(row.raw_output).toBeNull()
    expect(row.item_count).toBeNull()
    expect(row.finished_at).toBeNull()
    expect(row.input_tokens).toBeNull()
    expect(row.output_tokens).toBeNull()
    expect(row.cost_usd).toBeNull()
    expect(row.duration_ms).toBeNull()
    expect(row.prompt_chars).toBeNull()
    expect(row.turn_count).toBeNull()
    expect(row.tool_call_count).toBeNull()
    expect(row.trajectory_json).toBeNull()
    expect(row.dropped_json).toBeNull()
  })

  it('abort precedence: a run that aborts and then throws the metadata-carrying error still lands cancelled — no v2 columns, raw_output stays NULL', async () => {
    const { q } = makeQueue({
      distill: (_input, signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener(
            'abort',
            () =>
              rej(
                new DistillAgentRunError(
                  'budget exhausted (timeout) before a final answer',
                  'STALE RAW THAT MUST NOT LAND',
                  {
                    usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.05, durationMs: 100 },
                    turnCount: 10,
                    toolCallCount: 8,
                    trajectory: [{ turn: 1, tool: 'x', argsSummary: '{}' }],
                    promptChars: 100
                  }
                )
              ),
            { once: true }
          )
        })
    })
    const job = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })
    q.cancel(job.id)
    await q.idle()
    const row = db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(job.id) as Record<
      string,
      unknown
    >
    expect(row.state).toBe('cancelled')
    expect(row.raw_output).toBeNull()
    expect(row.error).toBeNull()
    expect(row.input_tokens).toBeNull()
    expect(row.output_tokens).toBeNull()
    expect(row.cost_usd).toBeNull()
    expect(row.duration_ms).toBeNull()
    expect(row.prompt_chars).toBeNull()
    expect(row.turn_count).toBeNull()
    expect(row.tool_call_count).toBeNull()
    expect(row.trajectory_json).toBeNull()
  })

  it('FIFO: three enqueues run one at a time in order', async () => {
    const order: string[] = []
    const { q } = makeQueue({
      distill: async (input) => {
        order.push((input as CaseDistillInput).caseMeta.slug)
        return { raw: '', output: {} }
      },
      assembleInput: (slug) => ({ caseMeta: { slug } }) as unknown as CaseDistillInput
    })
    q.enqueue('a')
    q.enqueue('b')
    q.enqueue('c')
    await q.idle()
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('recoverOnBoot flips running → failed', () => {
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('z','running','{}','t')`
    ).run()
    const { q } = makeQueue()
    expect(q.recoverOnBoot()).toBe(1)
    expect(q.statusFor('z')!.state).toBe('failed')
  })

  it('recoverOnBoot resumes a job stranded in queued state (e.g. app quit before its kick loop ran)', async () => {
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES ('z','queued','{"caseMeta":{"slug":"z"}}','t')`
    ).run()
    const { q } = makeQueue()
    q.recoverOnBoot()
    await q.idle()
    expect(q.statusFor('z')!.state).toBe('done')
  })

  it('loop continues past a failed job onto a distinct downstream job', async () => {
    const { q } = makeQueue({
      distill: async (input) => {
        const slug = (input as CaseDistillInput).caseMeta.slug
        if (slug === 'a') throw new Error('boom')
        return { raw: '', output: {} }
      },
      assembleInput: (slug) => ({ caseMeta: { slug } }) as unknown as CaseDistillInput
    })
    q.enqueue('a')
    q.enqueue('b')
    await q.idle()
    expect(q.statusFor('a')!.state).toBe('failed')
    expect(q.statusFor('b')!.state).toBe('done')
  })

  it('retry on a non-failed job throws', async () => {
    const { q } = makeQueue()
    const job = q.enqueue('case-a')
    await q.idle()
    expect(() => q.retry(job.id)).toThrow(/not failed/i)
  })

  it('N1: retry REFUSES an older failed job when a newer job is already queued/running for the slug, rather than cancelling the newer job (regression: retry re-queues an OLDER id but statusFor is MAX(id))', async () => {
    // Job 1 fails, job 2 is enqueued afterwards for the same slug and is still running (never
    // resolves). A stale retry click on job 1 must not cancel job 2 — every renderer read of
    // this slug goes through statusFor() (MAX(id)), so cancelling job 2 would make the UI show
    // "Re-distill"/no chip while job 2 keeps running unabortable. Refusing instead makes the
    // stale click a harmless no-op: job 1 stays failed, job 2 stays running.
    let calls = 0
    const { q } = makeQueue({
      distill: async () => {
        calls++
        if (calls === 1) throw new Error('boom')
        return new Promise(() => {}) // job 2 never resolves on its own
      }
    })
    const job1 = q.enqueue('case-a')
    await q.idle()
    expect(q.statusFor('case-a')!.id).toBe(job1.id)
    expect(q.statusFor('case-a')!.state).toBe('failed')

    const job2 = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })
    expect(job2.id).not.toBe(job1.id)

    expect(() => q.retry(job1.id)).toThrow(/in.?flight|already/i)

    const rows = db
      .prepare(`SELECT id, state FROM distill_jobs WHERE case_slug=? ORDER BY id`)
      .all('case-a') as { id: number; state: string }[]
    const byId = new Map(rows.map((r) => [r.id, r.state]))
    expect(byId.get(job1.id)).toBe('failed') // untouched by the refused retry
    expect(byId.get(job2.id)).toBe('running') // NOT cancelled by the refused retry
    expect(q.statusFor('case-a')!.id).toBe(job2.id)
    expect(q.statusFor('case-a')!.state).toBe('running')
  })

  it('throwing broadcast does not overwrite a done job with failed', async () => {
    const { q } = makeQueue({
      broadcast: () => {
        throw new Error('renderer gone')
      }
    })
    q.enqueue('case-a')
    await q.idle()
    expect(q.statusFor('case-a')!.state).toBe('done')
  })

  it('throwing broadcast does not stall the loop for later jobs', async () => {
    const { q } = makeQueue({
      broadcast: () => {
        throw new Error('renderer gone')
      }
    })
    q.enqueue('a')
    q.enqueue('b')
    await q.idle()
    expect(q.statusFor('a')!.state).toBe('done')
    expect(q.statusFor('b')!.state).toBe('done')
  })

  it('enqueue never throws due to a throwing broadcast', () => {
    const { q } = makeQueue({
      broadcast: () => {
        throw new Error('renderer gone')
      }
    })
    expect(() => q.enqueue('c')).not.toThrow()
  })

  it('records the runner failure reason on the job when no provider can distill', async () => {
    const { q } = makeQueue({
      distill: async () => {
        throw new Error('no provider configured for distillation')
      }
    })
    q.enqueue('case-a')
    await q.idle()
    const job = q.statusFor('case-a')!
    expect(job.state).toBe('failed')
    expect(job.error).toBe('no provider configured for distillation')
  })

  it('stamps prompt_hash at enqueue when the dep is provided', async () => {
    const { q } = makeQueue({ promptHash: () => 'abc123def456' })
    const job = q.enqueue('case-a')
    const row = db.prepare(`SELECT prompt_hash FROM distill_jobs WHERE id = ?`).get(job.id) as {
      prompt_hash: string | null
    }
    expect(row.prompt_hash).toBe('abc123def456')
    await q.idle()
  })

  it('prompt_hash is null when the dep is absent', async () => {
    const { q } = makeQueue()
    const job = q.enqueue('case-a')
    const row = db.prepare(`SELECT prompt_hash FROM distill_jobs WHERE id = ?`).get(job.id) as {
      prompt_hash: string | null
    }
    expect(row.prompt_hash).toBeNull()
    await q.idle()
  })

  it('cancels a queued job without ever running it', async () => {
    let ran = 0
    const { q } = makeQueue({
      distill: async () => {
        ran++
        await new Promise((r) => setTimeout(r, 50))
        return { raw: '```json\n{}\n```', output: {} }
      }
    })
    const first = q.enqueue('case-a') // occupies the single in-flight slot
    const second = q.enqueue('case-b') // still queued behind it
    expect(q.statusFor('case-b')!.state).toBe('queued')
    q.cancel(second.id)
    expect(q.statusFor('case-b')!.state).toBe('cancelled')
    await q.idle()
    expect(ran).toBe(1) // only case-a ever ran
    expect(q.statusFor('case-a')!.state).toBe('done')
    expect(q.statusFor('case-b')!.finishedAt).not.toBeNull()
    void first
  })

  it('cancels a running job: aborts the signal and lands cancelled, not failed', async () => {
    let seen: AbortSignal | null = null
    const { q, broadcasts } = makeQueue({
      distill: (_input, signal) => {
        seen = signal
        return new Promise((_res, rej) => {
          signal.addEventListener('abort', () => rej(new Error('headless run cancelled')), {
            once: true
          })
        })
      }
    })
    const job = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })
    q.cancel(job.id)
    expect(seen!.aborted).toBe(true)
    await q.idle()
    const done = q.statusFor('case-a')!
    expect(done.state).toBe('cancelled')
    expect(done.error).toBeNull()
    expect(done.finishedAt).not.toBeNull()
    expect(broadcasts.some((b) => (b as DistillStatusPayload).job?.state === 'cancelled')).toBe(
      true
    )
  })

  it('discards a result that lands after the cancel', async () => {
    let staged = 0
    let release: (() => void) | null = null
    const { q } = makeQueue({
      distill: () =>
        new Promise((res) => {
          release = () => res({ raw: '```json\n{}\n```', output: {} })
        }),
      stage: () => {
        staged++
        return { staged: 1, droppedDuplicates: 0, supersededRemoved: 0 }
      }
    })
    const job = q.enqueue('case-a')
    await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 5000 })
    q.cancel(job.id)
    release!() // the model "returns" after the user pressed cancel
    await q.idle()
    expect(staged).toBe(0)
    expect(q.statusFor('case-a')!.state).toBe('cancelled')
  })

  it('cancel on a resting job is a no-op returning the row', async () => {
    const { q } = makeQueue()
    const job = q.enqueue('case-a')
    await q.idle()
    expect(q.statusFor('case-a')!.state).toBe('done')
    const row = q.cancel(job.id)
    expect(row.state).toBe('done')
    expect(q.statusFor('case-a')!.state).toBe('done')
  })

  it('cancel on an unknown job id throws', () => {
    const { q } = makeQueue()
    expect(() => q.cancel(9999)).toThrow('9999')
  })

  it('cancelling a running job persists cancelled + finished_at synchronously, before the driver settles', async () => {
    const { q } = makeQueue({
      distill: (_input, signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener('abort', () => rej(new Error('headless run cancelled')), {
            once: true
          })
        })
    })
    const job = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })
    q.cancel(job.id)
    // Assert on the same synchronous call stack as cancel() — before any microtask from the
    // driver's rejection (fired by abort() above) has had a chance to run runJob's catch.
    const row = q.statusFor('case-a')!
    expect(row.state).toBe('cancelled')
    expect(row.finishedAt).not.toBeNull()
    await q.idle()
    expect(q.statusFor('case-a')!.state).toBe('cancelled')
  })

  it('recoverOnBoot does not touch a cancelled row: 0 changes, stays cancelled, not resumed', async () => {
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, finished_at) VALUES ('z','cancelled','{}','t','t2')`
    ).run()
    const { q } = makeQueue()
    expect(q.recoverOnBoot()).toBe(0)
    expect(q.statusFor('z')!.state).toBe('cancelled')
    await q.idle()
    expect(q.statusFor('z')!.state).toBe('cancelled')
  })

  it('a cancel that beats the driver teardown survives an app quit as cancelled, not failed', async () => {
    // recoverOnBoot's WHERE state='running' has never matched a directly-inserted 'cancelled'
    // row, so that alone (the test above) pins nothing about this task's change. The scenario
    // this feature was approved for is: cancel a job that is genuinely RUNNING, then the app
    // quits while the driver's CLI subprocess is still unwinding, before runJob's aborted-branch
    // rewrite ever gets a turn to run. This is RED against pre-fix code, where cancel() didn't
    // persist state='cancelled' synchronously and the row would still read 'running' at boot.
    const { q } = makeQueue({
      distill: (_input, signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener('abort', () => rej(new Error('x')), { once: true })
        })
    })
    const job = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })
    q.cancel(job.id)
    expect(q.recoverOnBoot()).toBe(0) // simulates the next boot, mid-teardown
    expect(q.statusFor('case-a')!.state).toBe('cancelled')
    await q.idle()
  })

  it('retry on a cancelled job throws', () => {
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, finished_at) VALUES ('z','cancelled','{}','t','t2')`
    ).run()
    const row = db.prepare(`SELECT id FROM distill_jobs WHERE case_slug='z'`).get() as {
      id: number
    }
    const { q } = makeQueue()
    expect(() => q.retry(row.id)).toThrow(/not failed/i)
  })

  it('cancel on a failed job is a no-op returning the row', async () => {
    const { q } = makeQueue({
      distill: async () => {
        throw new Error('boom')
      }
    })
    const job = q.enqueue('case-a')
    await q.idle()
    expect(q.statusFor('case-a')!.state).toBe('failed')
    const row = q.cancel(job.id)
    expect(row.state).toBe('failed')
    expect(q.statusFor('case-a')!.state).toBe('failed')
  })

  it('a second cancel on an already-cancelled job is idempotent: finished_at does not move', async () => {
    const { q } = makeQueue({
      distill: (_input, signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener('abort', () => rej(new Error('headless run cancelled')), {
            once: true
          })
        })
    })
    const job = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })
    const first = q.cancel(job.id)
    expect(first.finishedAt).not.toBeNull()
    const second = q.cancel(job.id)
    expect(second.state).toBe('cancelled')
    expect(second.finishedAt).toBe(first.finishedAt)

    // The assertions above pass even without COALESCE in finishCancelled, because they never
    // exercise it: this second cancel() hits cancel()'s own resting-state early return (the
    // job is already 'cancelled') and never reaches runJob's aborted-branch rewrite at all.
    // Force that rewrite to actually run, over a value no clock reading could ever produce by
    // accident, to prove COALESCE — not clock-resolution luck — is what preserves finished_at.
    db.prepare(`UPDATE distill_jobs SET finished_at='SENTINEL' WHERE id=?`).run(job.id)
    await q.idle() // runJob's catch (still pending on the driver's abort rejection) runs finishCancelled
    expect(q.statusFor('case-a')!.finishedAt).toBe('SENTINEL')
  })

  it('F1: closing a case with a job in flight cancels it before enqueueing the close-time job', async () => {
    // Reproduces: distill an OPEN case (job A, running) → close the case → onCaseClosed used to
    // call enqueue() with no in-flight guard, leaving BOTH jobs alive. statusFor() (ORDER BY id
    // DESC) then reads only the newest job, so Cancel would stop the wrong one while the older,
    // still-running job kept going and staged proposals from the stale open-case snapshot.
    // reconcileAndEnqueue must cancel any in-flight job for the slug first.
    let calls = 0
    let releaseFirst: (() => void) | null = null
    const stageCalls: number[] = []
    const { q } = makeQueue({
      distill: () => {
        calls++
        if (calls === 1) {
          return new Promise((res) => {
            releaseFirst = () => res({ raw: '```json\n{}\n```', output: {} })
          })
        }
        return Promise.resolve({ raw: '```json\n{}\n```', output: {} })
      },
      stage: (_slug, jobId) => {
        stageCalls.push(jobId as number)
        return { staged: 1, droppedDuplicates: 0, supersededRemoved: 0 }
      }
    })
    const jobA = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })

    const jobB = reconcileAndEnqueue(q, 'case-a')
    expect(jobB.id).not.toBe(jobA.id)

    // A is cancelled synchronously, before this call returns.
    const midA = db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(jobA.id) as {
      state: string
    }
    expect(midA.state).toBe('cancelled')

    releaseFirst!() // let A's driver call "resolve" after the cancel — must not reach stage()
    await q.idle()

    expect(stageCalls).toEqual([jobB.id]) // A's stage() must NOT be called
    const finalA = db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(jobA.id) as {
      state: string
    }
    expect(finalA.state).toBe('cancelled')
    const finalB = q.statusFor('case-a')!
    expect(finalB.id).toBe(jobB.id)
    expect(finalB.state).toBe('done')
  })

  it('cancelling a queued job emits a broadcast carrying the cancelled row', async () => {
    const { q, broadcasts } = makeQueue({
      distill: async () => {
        await new Promise((r) => setTimeout(r, 50))
        return { raw: '```json\n{}\n```', output: {} }
      }
    })
    q.enqueue('case-a') // occupies the single in-flight slot
    const second = q.enqueue('case-b') // still queued behind it
    q.cancel(second.id)
    expect(
      broadcasts.some(
        (b) =>
          (b as DistillStatusPayload).caseSlug === 'case-b' &&
          (b as DistillStatusPayload).job?.state === 'cancelled'
      )
    ).toBe(true)
    await q.idle()
  })

  it('F2: a bare enqueue() call for an already in-flight slug — exactly what the redistill IPC handler called before this fix — must not leave two jobs alive', async () => {
    // Before this fix, `IPC.distillRedistill` called `distillQueue.enqueue(slug)` directly, with
    // no in-flight guard at all (unlike the close path, which went through reconcileAndEnqueue).
    // A stale renderer row (F1), a swallowed broadcast (DistillQueue.emit() deliberately swallows
    // failures), or two windows racing one IPC round-trip could all reach it for a slug that
    // already has an in-flight job. Post-fix the guard lives inside enqueue() itself (so it can't
    // be bypassed by any caller, not just the ones wrapped in reconcileAndEnqueue) — this test
    // calls enqueue() bare, the same way the old handler did, and pins that it is now safe on its
    // own.
    const { q } = makeQueue({ distill: () => new Promise(() => {}) /* never resolves */ })
    const jobA = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })

    const jobB = q.enqueue('case-a') // the exact call distillRedistill's handler makes
    expect(jobB.id).not.toBe(jobA.id)

    const rows = db
      .prepare(
        `SELECT id, state FROM distill_jobs WHERE case_slug=? AND state IN ('queued','running')`
      )
      .all('case-a') as { id: number; state: string }[]
    expect(rows.map((r) => r.id)).toEqual([jobB.id])
    const finalA = db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(jobA.id) as {
      state: string
    }
    expect(finalA.state).toBe('cancelled')
  })

  it('F4: reconcile cancels EVERY in-flight job for the slug, not just the newest (regression: statusFor is MAX(id))', async () => {
    // If a slug ever holds a running job (A) plus a separately-queued job (B) — e.g. a stale row
    // that slipped past a not-yet-fixed caller, or data from before this fix — the old
    // reconcileAndEnqueue only cancelled B (the newest, via statusFor's ORDER BY id DESC),
    // leaving A running unaborted: the original "two jobs alive" bug, reintroduced through a
    // different door. Inserted directly (not via two enqueue() calls) so this test exercises
    // cancel-completeness independently of how such a row could arise.
    const { q } = makeQueue({ distill: () => new Promise(() => {}) /* never resolves */ })
    const jobA = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })

    const stale = db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at) VALUES (?, 'queued', '{}', ?)`
      )
      .run('case-a', new Date().toISOString())
    const staleId = Number(stale.lastInsertRowid)

    const jobC = reconcileAndEnqueue(q, 'case-a')

    const rows = db
      .prepare(`SELECT id, state FROM distill_jobs WHERE case_slug=? ORDER BY id`)
      .all('case-a') as { id: number; state: string }[]
    const byId = new Map(rows.map((r) => [r.id, r.state]))
    expect(byId.get(jobA.id)).toBe('cancelled')
    expect(byId.get(staleId)).toBe('cancelled')

    const inFlight = rows.filter((r) => r.state === 'queued' || r.state === 'running')
    expect(inFlight.map((r) => r.id)).toEqual([jobC.id])
  })

  it('F5: if the replacement snapshot throws, the previously in-flight job must not already be cancelled (regression: cancel-then-enqueue destroys the run with nothing to replace it)', async () => {
    let calls = 0
    const { q } = makeQueue({
      assembleInput: () => {
        calls++
        if (calls === 1) return INPUT
        throw new Error('snapshot boom')
      },
      distill: () => new Promise(() => {}) /* never resolves on its own */
    })
    const jobA = q.enqueue('case-a')
    await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'), { timeout: 5000 })

    expect(() => reconcileAndEnqueue(q, 'case-a')).toThrow('snapshot boom')

    // Job A must still be the one and only in-flight job for the slug — untouched — not
    // cancelled just because the replacement enqueue's snapshot failed.
    const cur = q.statusFor('case-a')!
    expect(cur.id).toBe(jobA.id)
    expect(cur.state).toBe('running')
  })

  it('statusFor and needsDistillRun are blind to a reject-digest row for the same slug', async () => {
    const { q } = makeQueue()
    createCase(db, home, { slug: 'case-a', title: 'T' })
    q.enqueue('case-a')
    await q.idle()
    const caseJob = q.statusFor('case-a')!
    expect(caseJob.state).toBe('done')
    // A later reject-digest row for the same slug, with a HIGHER id than the case job.
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
       VALUES ('case-a', 'done', '{}', ?, 'reject-digest')`
    ).run(new Date().toISOString())
    expect(q.statusFor('case-a')!.id).toBe(caseJob.id)
    expect(q.statusFor('case-a')!.state).toBe('done')
    expect(needsDistillRun(db, q, 'case-a')).toBe(false) // digest row must not be read as "needs a run"
  })

  it('records every v2 usage/trajectory column on a done job, and trajectory_json parses back', async () => {
    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'mcp__argus__list_sessions', argsSummary: '{}', resultBytes: 42 },
      { turn: 2, tool: 'mcp__argus__read_transcript', argsSummary: '{"session_id":1}' }
    ]
    const { q, broadcasts } = makeQueue({
      distill: async () => ({
        raw: '```json\n{}\n```',
        output: {},
        promptChars: 1234,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, durationMs: 900 },
        turnCount: 4,
        toolCallCount: 7,
        trajectory
      })
    })
    q.enqueue('case-a')
    await q.idle()
    const job = q.statusFor('case-a')!
    expect(job.state).toBe('done')
    // IPC row (toRow) carries the four Task-16-facing columns.
    expect(job.costUsd).toBe(0.02)
    expect(job.turnCount).toBe(4)
    expect(job.toolCallCount).toBe(7)
    expect(job.promptChars).toBe(1234)
    // Full DB row carries every v2 column, and trajectory_json round-trips.
    const row = db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(job.id) as Record<
      string,
      unknown
    >
    expect(row.input_tokens).toBe(10)
    expect(row.output_tokens).toBe(5)
    expect(row.cost_usd).toBe(0.02)
    expect(row.duration_ms).toBe(900)
    expect(row.prompt_chars).toBe(1234)
    expect(row.turn_count).toBe(4)
    expect(row.tool_call_count).toBe(7)
    expect(row.dropped_json).toBeNull() // Task 14 fills this; null until then
    expect(JSON.parse(row.trajectory_json as string)).toEqual(trajectory)
    // The broadcast payload (what the renderer actually receives) carries the same four fields.
    const doneBroadcast = broadcasts.find(
      (b) => (b as DistillStatusPayload).job?.state === 'done'
    ) as DistillStatusPayload
    expect(doneBroadcast.job).toMatchObject({
      costUsd: 0.02,
      turnCount: 4,
      toolCallCount: 7,
      promptChars: 1234
    })
  })

  it('truncates trajectory_json to the FIRST entries that fit under the 32KB cap (loop-start context matters most)', async () => {
    const trajectory: TrajectoryEntry[] = Array.from({ length: 2000 }, (_, i) => ({
      turn: i,
      tool: 'mcp__argus__search_transcript',
      argsSummary: JSON.stringify({ query: `q${i}`.padEnd(30, 'x') })
    }))
    expect(JSON.stringify(trajectory).length).toBeGreaterThan(TRAJECTORY_JSON_CAP) // sanity: fixture exceeds the cap
    const { q } = makeQueue({
      distill: async () => ({ raw: '```json\n{}\n```', output: {}, trajectory })
    })
    q.enqueue('case-a')
    await q.idle()
    const job = q.statusFor('case-a')!
    const row = db.prepare(`SELECT trajectory_json FROM distill_jobs WHERE id = ?`).get(job.id) as {
      trajectory_json: string
    }
    expect(row.trajectory_json.length).toBeLessThanOrEqual(TRAJECTORY_JSON_CAP)
    const kept = JSON.parse(row.trajectory_json) as { turn: number }[]
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(trajectory.length)
    expect(kept.map((e) => e.turn)).toEqual(trajectory.slice(0, kept.length).map((e) => e.turn))
  })

  it('a capHit run fails the job but persists raw_output + usage/turn/tool/trajectory columns (Task 12 handoff decision)', async () => {
    const trajectory: TrajectoryEntry[] = [{ turn: 1, tool: 'x', argsSummary: '{}' }]
    const { q } = makeQueue({
      distill: async () => {
        throw new DistillAgentRunError(
          'budget exhausted (iterations/error_max_turns) before a final answer',
          'STALE RAW TEXT',
          {
            usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01, durationMs: 500 },
            turnCount: 50,
            toolCallCount: 40,
            trajectory,
            promptChars: 999
          }
        )
      }
    })
    q.enqueue('case-a')
    await q.idle()
    const job = q.statusFor('case-a')!
    expect(job.state).toBe('failed')
    expect(job.error).toContain('budget exhausted')
    expect(job.costUsd).toBe(0.01)
    expect(job.turnCount).toBe(50)
    expect(job.toolCallCount).toBe(40)
    expect(job.promptChars).toBe(999)
    const row = db
      .prepare(
        `SELECT raw_output, input_tokens, output_tokens, duration_ms, trajectory_json, item_count FROM distill_jobs WHERE id = ?`
      )
      .get(job.id) as {
      raw_output: string
      input_tokens: number
      output_tokens: number
      duration_ms: number
      trajectory_json: string
      item_count: number | null
    }
    expect(row.raw_output).toBe('STALE RAW TEXT')
    expect(row.input_tokens).toBe(1)
    expect(row.output_tokens).toBe(2)
    expect(row.duration_ms).toBe(500)
    expect(JSON.parse(row.trajectory_json)).toEqual(trajectory)
    expect(row.item_count).toBeNull() // staging never ran on a failed job
  })

  it('a capHit error with no agentMeta at all still fails cleanly with raw_output preserved (defensive: usage columns null, not a crash)', async () => {
    const { q } = makeQueue({
      distill: async () => {
        throw new DistillAgentRunError('budget exhausted (timeout) before a final answer', 'RAW')
      }
    })
    q.enqueue('case-a')
    await q.idle()
    const job = q.statusFor('case-a')!
    expect(job.state).toBe('failed')
    expect(job.costUsd).toBeNull()
    expect(job.turnCount).toBeNull()
    const row = db.prepare(`SELECT raw_output FROM distill_jobs WHERE id = ?`).get(job.id) as {
      raw_output: string
    }
    expect(row.raw_output).toBe('RAW')
  })

  it('a kind=reject-digest row fails cleanly without ever calling the agent runner (Task 13 adds its own runner)', async () => {
    let called = 0
    const { q } = makeQueue({
      distill: async () => {
        called++
        return { raw: '```json\n{}\n```', output: {} }
      }
    })
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
       VALUES ('case-a', 'queued', '{"caseMeta":{"slug":"case-a"}}', ?, 'reject-digest')`
    ).run(new Date().toISOString())
    q.recoverOnBoot()
    await q.idle()
    const row = db
      .prepare(
        `SELECT state, error FROM distill_jobs WHERE case_slug='case-a' AND kind='reject-digest'`
      )
      .get() as { state: string; error: string }
    expect(row.state).toBe('failed')
    expect(row.error).toMatch(/reject-digest/)
    expect(called).toBe(0) // the guard must trip BEFORE the agent runner is ever invoked
  })
})

describe('needsDistillRun', () => {
  it('true when no job has ever run', () => {
    const { q } = makeQueue()
    createCase(db, home, { slug: 'case-a', title: 'T' })
    expect(needsDistillRun(db, q, 'case-a')).toBe(true)
  })

  it('false while the latest job is queued or running', () => {
    const { q } = makeQueue({ distill: () => new Promise(() => {}) }) // never resolves
    createCase(db, home, { slug: 'case-a', title: 'T' })
    q.enqueue('case-a')
    expect(needsDistillRun(db, q, 'case-a')).toBe(false)
  })

  it('true when the latest job failed', async () => {
    const { q } = makeQueue({
      distill: async () => {
        throw new DistillParseError('bad', 'RAW')
      }
    })
    createCase(db, home, { slug: 'case-a', title: 'T' })
    q.enqueue('case-a')
    await q.idle()
    expect(needsDistillRun(db, q, 'case-a')).toBe(true)
  })

  it('true when the latest job was cancelled', () => {
    const { q } = makeQueue({ distill: () => new Promise(() => {}) })
    createCase(db, home, { slug: 'case-a', title: 'T' })
    const job = q.enqueue('case-a')
    q.cancel(job.id)
    expect(needsDistillRun(db, q, 'case-a')).toBe(true)
  })

  it('false when the latest job is done and no evidence arrived since', async () => {
    const { q } = makeQueue()
    createCase(db, home, { slug: 'case-a', title: 'T' })
    q.enqueue('case-a')
    await q.idle()
    expect(needsDistillRun(db, q, 'case-a')).toBe(false)
  })

  it("true when evidence was added after the last done job's snapshot", async () => {
    const { q } = makeQueue()
    const rec = createCase(db, home, { slug: 'case-a', title: 'T' })
    q.enqueue('case-a')
    await q.idle()
    db.prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, created_at) VALUES (?, 'new.log', 'abc', 'text', 10, ?)`
    ).run(rec.id, '9999-01-01T00:00:00.000Z')
    expect(needsDistillRun(db, q, 'case-a')).toBe(true)
  })
})
