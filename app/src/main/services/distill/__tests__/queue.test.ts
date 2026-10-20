import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import {
  DistillQueue,
  reconcileAndEnqueue,
  needsDistillRun,
  TRAJECTORY_JSON_CAP,
  pipelineOf,
  routeCaseClose
} from '../queue'
import { DistillParseError } from '../contract'
import { DistillAgentRunError } from '../caseDistiller'
import { DIGEST_CASE_SLUG, readRejectDigest } from '../rejectDigest'
import { proposalsArchiveDir } from '../../paths'
import type {
  CaseDistillInput,
  DistillProgress,
  DistillStatusPayload
} from '../../../../shared/distill'
import type { TrajectoryEntry } from '../../agent/driver'
import { listArchivedProposals } from '../../proposals'

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
    stage: () => ({ staged: 0, droppedDuplicates: 0, supersededRemoved: 0, dropped: [] }),
    broadcast: (p) => broadcasts.push(p),
    argusHome: home,
    // Empty by default (no reject archive on disk in a fresh temp home) so no existing test's
    // enqueue() call accidentally trips the reject-digest pre-check — 0 rejects is always below
    // DIGEST_TRIGGER_NEW_REJECTS.
    listArchivedProposalsFn: () => [],
    runOneShot: async () => ({ text: '- placeholder' }),
    ...over
  })
  return { q, broadcasts }
}

/** Writes an archived-reject file directly under `<home>/proposals/archive`, matching the shape
 *  `listArchivedProposals` parses. Used to make a real `listArchivedProposalsFn`/`digestStale`
 *  pairing exercise the actual file-backed staleness check rather than a hand-rolled fake list. */
function archiveReject(
  home: string,
  name: string,
  fields: { type?: string; tag?: string; note?: string } = {}
): void {
  const dir = proposalsArchiveDir(home)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    [
      '---',
      `type: ${fields.type ?? 'reference-edit'}`,
      `target: ${name}`,
      'case: case-a',
      'date: 2026-01-01T00:00:00.000Z',
      'title: T',
      'status: rejected',
      `reject_reason: ${fields.tag ?? 'overgeneric'}`,
      ...(fields.note ? [`reject_note: ${fields.note}`] : []),
      '---',
      'body'
    ].join('\n')
  )
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
              promptChars: 777,
              stages: {
                dossier: { promptHash: 'h', promptChars: 1, rawOutput: 'raw', error: 'boom' }
              }
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
      .prepare(`SELECT trajectory_json, stages_json FROM distill_jobs WHERE id = ?`)
      .get(failed.id) as { trajectory_json: string | null; stages_json: string | null }
    expect(preRetryRow.trajectory_json).not.toBeNull()
    expect(preRetryRow.stages_json).not.toBeNull() // sanity: v3 stages really were recorded too

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
    expect(row.stages_json).toBeNull()
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

  it('retry() re-stamps prompt_hash with the CURRENT dep value, not the one captured at enqueue', async () => {
    let hash = 'h1'
    const { q } = makeQueue({
      promptHash: () => hash,
      distill: async () => {
        throw new Error('boom')
      }
    })
    const job = q.enqueue('case-a')
    await q.idle()
    expect(q.statusFor('case-a')!.state).toBe('failed')
    const preRetryRow = db
      .prepare(`SELECT prompt_hash FROM distill_jobs WHERE id = ?`)
      .get(job.id) as { prompt_hash: string | null }
    expect(preRetryRow.prompt_hash).toBe('h1') // sanity: the enqueue-time hash really was 'h1'

    // Simulate the settings flag flipping (v2 -> v3, or any prompt change) while the job sat
    // failed, before the user clicks retry.
    hash = 'h2'
    q.retry(job.id)
    const row = db.prepare(`SELECT prompt_hash FROM distill_jobs WHERE id = ?`).get(job.id) as {
      prompt_hash: string | null
    }
    expect(row.prompt_hash).toBe('h2')
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
        return { staged: 1, droppedDuplicates: 0, supersededRemoved: 0, dropped: [] }
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
        return { staged: 1, droppedDuplicates: 0, supersededRemoved: 0, dropped: [] }
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
    expect(row.dropped_json).toBe('[]') // the mock's stage() returned an empty dropped list
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

  it("(d) persists dropped_json on a done job, tagging stage()'s drops with stage: 'staging'", async () => {
    const dropped = [
      { type: 'reference-edit', target: 'topic-4', title: 'T4', reason: 'cap' as const },
      { type: 'reference-edit', target: 'short-basis', title: 'Short', reason: 'basis' as const }
    ]
    const { q } = makeQueue({
      stage: () => ({ staged: 3, droppedDuplicates: 0, supersededRemoved: 0, dropped })
    })
    q.enqueue('case-a')
    await q.idle()
    const job = q.statusFor('case-a')!
    expect(job.state).toBe('done')
    const row = db.prepare(`SELECT dropped_json FROM distill_jobs WHERE id = ?`).get(job.id) as {
      dropped_json: string | null
    }
    // Every field of stage()'s own drop survives verbatim, plus the origin tag queue.ts adds so a
    // reader can't confuse a staging cap/basis drop for a same-named veto/validator one.
    expect(JSON.parse(row.dropped_json!)).toEqual(dropped.map((d) => ({ ...d, stage: 'staging' })))
  })

  it('persists stages_json and merges pre-stage drops AHEAD of staging drops in dropped_json on a done job', async () => {
    const stagingDrop = {
      type: 'reference-edit',
      target: 'topic-9',
      title: 'T9',
      reason: 'basis' as const
    }
    const { q } = makeQueue({
      distill: async () => ({
        raw: '```json\n{}\n```',
        output: {},
        usage: { durationMs: 1 },
        stages: { dossier: { promptHash: 'abc', promptChars: 1, rawOutput: 'x' } },
        preStageDropped: [
          { type: 'skill-new', target: 't', title: 'x', reason: 'cap' as const },
          { type: 'reference-edit', target: 'u', title: 'y', reason: 'case-identifiers' as const }
        ]
      }),
      stage: () => ({
        staged: 1,
        droppedDuplicates: 0,
        supersededRemoved: 0,
        dropped: [stagingDrop]
      })
    })
    q.enqueue('c1')
    await q.idle()
    const row = db.prepare(`SELECT state, stages_json, dropped_json FROM distill_jobs`).get() as {
      state: string
      stages_json: string
      dropped_json: string
    }
    expect(row.state).toBe('done')
    expect(JSON.parse(row.stages_json).dossier.promptHash).toBe('abc')
    // Pre-stage drops (veto/validator, recorded before staging ever ran) come FIRST, in the
    // order the pipeline recorded them; staging's own drops follow. A reader walking this array
    // sees the run's chronology, and the widened reason set ('case-identifiers' here) survives.
    const drops = JSON.parse(row.dropped_json) as {
      reason: string
      target: string
      stage?: string
    }[]
    expect(drops.map((d) => d.reason)).toEqual(['cap', 'case-identifiers', 'basis'])
    expect(drops.map((d) => d.target)).toEqual(['t', 'u', 'topic-9'])
    // The pipeline's own preStageDropped entries here carry no `stage` (synthetic fixture, as a
    // pre-origin-field row would) and pass through unchanged; only staging's OWN drop — merged in
    // by queue.ts, not the pipeline — is tagged with its origin, so a reader can't mistake a
    // staging cap/basis drop for a veto/validator one.
    expect(drops.map((d) => d.stage)).toEqual([undefined, undefined, 'staging'])
  })

  it('persists stages_json on a failed agentic job', async () => {
    const { q } = makeQueue({
      distill: async () => {
        throw new DistillAgentRunError('boom', 'raw', {
          stages: { dossier: { promptHash: 'h', promptChars: 1, rawOutput: 'raw', error: 'boom' } }
        })
      }
    })
    q.enqueue('c1')
    await q.idle()
    const row = db.prepare(`SELECT state, stages_json FROM distill_jobs`).get() as {
      state: string
      stages_json: string
    }
    expect(row.state).toBe('failed')
    expect(JSON.parse(row.stages_json).dossier.error).toBe('boom')
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

  it('a kind=reject-digest row runs the real digest runner (rebuilds the file, item_count 0, done) and never calls the agent runner', async () => {
    archiveReject(home, 'r1')
    let agentCalled = 0
    let oneShotCalled = 0
    const { q } = makeQueue({
      distill: async () => {
        agentCalled++
        return { raw: '```json\n{}\n```', output: {} }
      },
      listArchivedProposalsFn: () =>
        [{ status: 'rejected' }] as unknown as ReturnType<typeof listArchivedProposals>,
      runOneShot: async () => {
        oneShotCalled++
        return { text: '- avoid X' }
      }
    })
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
       VALUES (?, 'queued', '{}', ?, 'reject-digest')`
    ).run(DIGEST_CASE_SLUG, new Date().toISOString())
    q.recoverOnBoot()
    await q.idle()
    const row = db
      .prepare(`SELECT state, item_count, error FROM distill_jobs WHERE kind='reject-digest'`)
      .get() as { state: string; item_count: number | null; error: string | null }
    expect(row.state).toBe('done')
    expect(row.item_count).toBe(0)
    expect(row.error).toBeNull()
    expect(agentCalled).toBe(0) // the case-distiller agent runner must never see a digest row
    expect(oneShotCalled).toBe(1)
    expect(readRejectDigest(home)?.text).toBe('- avoid X')
  })

  it('a failing digest job (kind=reject-digest) lands failed cleanly, without touching the agent runner', async () => {
    let agentCalled = 0
    const { q } = makeQueue({
      distill: async () => {
        agentCalled++
        return { raw: '```json\n{}\n```', output: {} }
      },
      runOneShot: async () => {
        throw new Error('provider unavailable')
      }
    })
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
       VALUES (?, 'queued', '{}', ?, 'reject-digest')`
    ).run(DIGEST_CASE_SLUG, new Date().toISOString())
    q.recoverOnBoot()
    await q.idle()
    const row = db
      .prepare(`SELECT state, error FROM distill_jobs WHERE kind='reject-digest'`)
      .get() as { state: string; error: string }
    expect(row.state).toBe('failed')
    expect(row.error).toBe('provider unavailable')
    expect(agentCalled).toBe(0)
  })

  it('a bullet-free model response fails the digest job and leaves the PREVIOUS file + reject_count untouched (never a silent self-disable)', async () => {
    // Build a real, good digest first — this is what must survive the bad rebuild below.
    const { q: q1 } = makeQueue({ runOneShot: async () => ({ text: '- keep this good digest' }) })
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
       VALUES (?, 'queued', '{}', ?, 'reject-digest')`
    ).run(DIGEST_CASE_SLUG, new Date().toISOString())
    q1.recoverOnBoot()
    await q1.idle()
    const goodDigest = readRejectDigest(home)!
    expect(goodDigest.text).toBe('- keep this good digest')

    const { q: q2 } = makeQueue({ runOneShot: async () => ({ text: 'no bullets here at all' }) })
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
       VALUES (?, 'queued', '{}', ?, 'reject-digest')`
    ).run(DIGEST_CASE_SLUG, new Date().toISOString())
    q2.recoverOnBoot()
    await q2.idle()

    const row = db
      .prepare(
        `SELECT state, error FROM distill_jobs WHERE kind='reject-digest' AND case_slug=? ORDER BY id DESC LIMIT 1`
      )
      .get(DIGEST_CASE_SLUG) as { state: string; error: string }
    expect(row.state).toBe('failed')
    expect(row.error).toMatch(/no usable bullets/)
    const stillGood = readRejectDigest(home)!
    expect(stillGood.text).toBe('- keep this good digest') // NOT overwritten with an empty digest
    expect(stillGood.rejectCount).toBe(goodDigest.rejectCount) // NOT advanced either
  })

  it('cancelling a running digest job aborts the signal the fake runner observes, lands cancelled (not failed), and the queue proceeds to the next job', async () => {
    let seenSignal: AbortSignal | null = null
    const { q } = makeQueue({
      runOneShot: (_prompt, opts) =>
        new Promise((_res, rej) => {
          seenSignal = opts?.signal ?? null
          opts?.signal?.addEventListener('abort', () => rej(new Error('digest run cancelled')), {
            once: true
          })
        })
    })
    const res = db
      .prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
         VALUES (?, 'queued', '{}', ?, 'reject-digest')`
      )
      .run(DIGEST_CASE_SLUG, new Date().toISOString())
    const digestId = Number(res.lastInsertRowid)
    q.recoverOnBoot()
    await vi.waitFor(
      () => {
        const r = db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(digestId) as {
          state: string
        }
        expect(r.state).toBe('running')
      },
      { timeout: 5000 }
    )
    expect(seenSignal).not.toBeNull() // runOneShot was actually given a signal to observe

    q.cancel(digestId)
    expect(seenSignal!.aborted).toBe(true) // cancel() reached the in-flight digest runner

    // The next job in the queue must still run — cancelling the digest must not stall the loop.
    q.enqueue('case-a')
    await q.idle()

    const digestRow = db
      .prepare(`SELECT state, error FROM distill_jobs WHERE id=?`)
      .get(digestId) as { state: string; error: string | null }
    expect(digestRow.state).toBe('cancelled')
    expect(digestRow.error).toBeNull()
    expect(q.statusFor('case-a')!.state).toBe('done')
  })

  it('end-to-end with the REAL listArchivedProposals (no fake): a real archived rejected proposal on disk drives enqueue → stale check → digest prompt, tag and note intact', async () => {
    archiveReject(home, 'real-1', {
      type: 'skill-new',
      tag: 'overfit',
      note: 'baked in a case-specific hostname'
    })
    for (let i = 0; i < 4; i++) archiveReject(home, `filler-${i}`) // 5 total → stale
    let seenPrompt = ''
    const { q } = makeQueue({
      listArchivedProposalsFn: () => listArchivedProposals(home), // the real function, not a fake
      runOneShot: async (prompt) => {
        seenPrompt = prompt
        return { text: '- avoid hardcoding hostnames' }
      }
    })
    q.enqueue('case-a')
    await q.idle()
    expect(seenPrompt).toContain('- overfit: 1')
    expect(seenPrompt).toContain('overfit skill-new: baked in a case-specific hostname')
    expect(readRejectDigest(home)?.text).toBe('- avoid hardcoding hostnames')
  })

  describe('reject-digest: enqueue trigger + run-start merge', () => {
    it("a throwing assembleInput leaves NO orphaned digest row — enqueue's documented throw contract ('nothing has been touched yet') extends to the digest pre-check", async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5') // stale, would otherwise trigger a digest insert
      const { q } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        assembleInput: () => {
          throw new Error('snapshot boom')
        }
      })
      expect(() => q.enqueue('case-a')).toThrow('snapshot boom')
      const rows = db.prepare(`SELECT id FROM distill_jobs`).all()
      expect(rows.length).toBe(0) // no digest row, no case row — truly nothing touched
    })

    it('(d) enqueue(slug) on a stale digest inserts a reject-digest row BEFORE the case row (lower id), and FIFO runs it first', async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5') // 5 rejects, no digest file yet → stale (>= DIGEST_TRIGGER_NEW_REJECTS)
      const order: string[] = []
      const { q } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        runOneShot: async () => {
          order.push('digest')
          return { text: '- avoid X' }
        },
        assembleInput: (slug) => ({ caseMeta: { slug } }) as unknown as CaseDistillInput,
        distill: async (input) => {
          order.push((input as CaseDistillInput).caseMeta.slug)
          return { raw: '', output: {} }
        }
      })
      const caseJob = q.enqueue('case-a')
      const digestRow = db
        .prepare(`SELECT id FROM distill_jobs WHERE kind='reject-digest'`)
        .get() as { id: number }
      expect(digestRow.id).toBeLessThan(caseJob.id)
      await q.idle()
      expect(order).toEqual(['digest', 'case-a']) // FIFO: lower id (digest) ran first
      expect(q.statusFor('case-a')!.state).toBe('done')
    })

    it('(d) a digest job failure leaves the case job running fine (with whatever the — possibly absent — digest file says)', async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5')
      const { q } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        runOneShot: async () => {
          throw new Error('llm down')
        }
      })
      q.enqueue('case-a')
      await q.idle()
      const digestRow = db
        .prepare(`SELECT state FROM distill_jobs WHERE kind='reject-digest'`)
        .get() as { state: string }
      expect(digestRow.state).toBe('failed')
      expect(q.statusFor('case-a')!.state).toBe('done') // unblocked despite the digest failure
      expect(readRejectDigest(home)).toBeNull() // never got built — stays stale for next time
    })

    it("(e) run-start merge: after the digest job rewrites the file, the case job's ON-DISK input_snapshot carries rejectDigest equal to the current file text", async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5')
      const { q } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        runOneShot: async () => ({ text: '- never propose retry-with-backoff again' })
      })
      const caseJob = q.enqueue('case-a')
      await q.idle()
      const row = db
        .prepare(`SELECT input_snapshot FROM distill_jobs WHERE id=?`)
        .get(caseJob.id) as { input_snapshot: string }
      const parsed = JSON.parse(row.input_snapshot) as CaseDistillInput
      const digest = readRejectDigest(home)!
      expect(digest.text).toBe('- never propose retry-with-backoff again')
      expect(parsed.rejectDigest).toBe(digest.text)
    })

    it('a case job run BEFORE any digest exists carries no rejectDigest, and never writes the row back', async () => {
      const { q } = makeQueue() // listArchivedProposalsFn: () => [] by default → never stale
      const caseJob = q.enqueue('case-a')
      const beforeSnapshot = db
        .prepare(`SELECT input_snapshot FROM distill_jobs WHERE id=?`)
        .get(caseJob.id) as { input_snapshot: string }
      await q.idle()
      const afterSnapshot = db
        .prepare(`SELECT input_snapshot FROM distill_jobs WHERE id=?`)
        .get(caseJob.id) as { input_snapshot: string }
      expect(afterSnapshot.input_snapshot).toBe(beforeSnapshot.input_snapshot)
      expect(JSON.parse(afterSnapshot.input_snapshot).rejectDigest).toBeUndefined()
    })
  })

  describe('reject-digest: broadcast + retry + supersede isolation', () => {
    it("emit() is NEVER called (no broadcast) at any point in a digest job's full lifecycle: enqueue, running, done", async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5')
      const { q, broadcasts } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        runOneShot: async () => ({ text: '- x' })
      })
      q.enqueue('case-a')
      await q.idle()
      // Every distill_jobs row touched during this run, case job included, must have gone
      // through — the digest row specifically must never appear on any broadcast payload.
      expect(
        broadcasts.some((b) => (b as DistillStatusPayload).caseSlug === DIGEST_CASE_SLUG)
      ).toBe(false)
      expect(broadcasts.length).toBeGreaterThan(0) // sanity: the case job DID broadcast
    })

    it('emit() is never called even when a digest job fails', async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5')
      const { q, broadcasts } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        runOneShot: async () => {
          throw new Error('boom')
        }
      })
      q.enqueue('case-a')
      await q.idle()
      expect(
        broadcasts.some((b) => (b as DistillStatusPayload).caseSlug === DIGEST_CASE_SLUG)
      ).toBe(false)
    })

    it('retry() refuses a failed reject-digest job (decision: digest jobs are never manually retried — the next stale enqueue rebuilds it)', async () => {
      const { q } = makeQueue()
      const res = db
        .prepare(
          `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, finished_at, kind)
           VALUES (?, 'failed', '{}', ?, ?, 'reject-digest')`
        )
        .run(DIGEST_CASE_SLUG, new Date().toISOString(), new Date().toISOString())
      const jobId = Number(res.lastInsertRowid)
      expect(() => q.retry(jobId)).toThrow(/not retryable/)
    })

    it("a case enqueue's cancelOtherInFlight must never cancel an in-flight reject-digest job (different case_slug already scopes it, but pin the regression)", async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5')
      let releaseDigest: (() => void) | null = null
      const { q } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        runOneShot: () =>
          new Promise((res) => {
            releaseDigest = () => res({ text: '- x' })
          })
      })
      q.enqueue('case-a') // triggers the digest pre-check → digest row queued, runs first
      await vi.waitFor(
        () => {
          const row = db
            .prepare(`SELECT state FROM distill_jobs WHERE kind='reject-digest'`)
            .get() as { state: string }
          expect(row.state).toBe('running')
        },
        { timeout: 5000 }
      )
      // A second, unrelated case enqueue while the digest is running: its own cancelOtherInFlight
      // is scoped to case_slug='case-b', so it must never touch the digest row (case_slug is the
      // sentinel, not 'case-b').
      q.enqueue('case-b')
      const digestRow = db
        .prepare(`SELECT state FROM distill_jobs WHERE kind='reject-digest'`)
        .get() as { state: string }
      expect(digestRow.state).toBe('running') // untouched by case-b's enqueue
      releaseDigest!()
      await q.idle()
      expect(
        (
          db.prepare(`SELECT state FROM distill_jobs WHERE kind='reject-digest'`).get() as {
            state: string
          }
        ).state
      ).toBe('done')
    })

    it('a burst of stale-triggering enqueues while a digest job is already queued/running does not pile up duplicate digest rows', async () => {
      archiveReject(home, 'r1')
      archiveReject(home, 'r2')
      archiveReject(home, 'r3')
      archiveReject(home, 'r4')
      archiveReject(home, 'r5')
      const { q } = makeQueue({
        listArchivedProposalsFn: () =>
          [1, 2, 3, 4, 5].map(() => ({ status: 'rejected' })) as unknown as ReturnType<
            typeof listArchivedProposals
          >,
        runOneShot: () => new Promise(() => {}) // never resolves — digest stays queued/running
      })
      q.enqueue('case-a')
      q.enqueue('case-b')
      q.enqueue('case-c')
      const rows = db.prepare(`SELECT id FROM distill_jobs WHERE kind='reject-digest'`).all()
      expect(rows.length).toBe(1)
    })

    it('statusFor(DIGEST_CASE_SLUG) is always null — no case-kind row can ever exist for the sentinel slug', async () => {
      const { q } = makeQueue()
      db.prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
         VALUES (?, 'done', '{}', ?, 'reject-digest')`
      ).run(DIGEST_CASE_SLUG, new Date().toISOString())
      expect(q.statusFor(DIGEST_CASE_SLUG)).toBeNull()
    })
  })

  it('stores and broadcasts progress for the running job, stamps staging itself, and clears on finish', async () => {
    const progress: DistillProgress[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { q } = makeQueue({
      broadcastProgress: (p) => progress.push(p),
      distill: async (_input, _signal, onProgress) => {
        onProgress({ phase: 'dossier', toolCalls: 2, detail: 'read_transcript s1' })
        await gate
        return { raw: '```json\n{}\n```', output: {} }
      }
    })
    const job = q.enqueue('case-a')
    await new Promise((r) => setTimeout(r, 0))
    expect(q.progressFor(job.id)).toMatchObject({
      jobId: job.id,
      caseSlug: 'case-a',
      phase: 'dossier',
      toolCalls: 2
    })
    expect(q.listAllRuns()[0].progress?.phase).toBe('dossier')
    release()
    await q.idle()
    expect(progress.map((p) => p.phase)).toEqual(['dossier', 'staging'])
    expect(q.progressFor(job.id)).toBeNull()
    expect(q.listAllRuns()[0].progress).toBeUndefined()
  })

  it('a throwing progress broadcaster never fails the job', async () => {
    const { q } = makeQueue({
      broadcastProgress: () => {
        throw new Error('renderer gone')
      },
      distill: async (_i, _s, onProgress) => {
        onProgress({ phase: 'agent' })
        return { raw: '```json\n{}\n```', output: {} }
      }
    })
    q.enqueue('case-a')
    await q.idle()
    expect(q.statusFor('case-a')!.state).toBe('done')
  })

  it('a dry run reports no staging phase', async () => {
    const progress: DistillProgress[] = []
    const { q } = makeQueue({
      broadcastProgress: (p) => progress.push(p),
      distill: async (_i, _s, onProgress) => {
        onProgress({ phase: 'agent' })
        return { raw: '```json\n{}\n```', output: {} }
      }
    })
    q.enqueueDryRun('case-a')
    await q.idle()
    expect(progress.map((p) => p.phase)).toEqual(['agent'])
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

describe('listRuns', () => {
  it("returns the case's jobs newest first, and no other case's or kind's", async () => {
    const { q } = makeQueue()
    createCase(db, home, { slug: 'a', title: 'A' })
    createCase(db, home, { slug: 'b', title: 'B' })
    const first = q.enqueue('a')
    await q.idle()
    const second = q.enqueue('a')
    await q.idle()
    q.enqueue('b')
    await q.idle()
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind)
       VALUES ('a', 'done', '{}', '2026-01-01T00:00:00.000Z', 'reject-digest')`
    ).run()

    const runs = q.listRuns('a')
    expect(runs.map((r) => r.id)).toEqual([second.id, first.id])
  })

  it('returns an empty array for a case that was never distilled', () => {
    const { q } = makeQueue()
    createCase(db, home, { slug: 'c', title: 'C' })
    expect(q.listRuns('c')).toEqual([])
  })
})

describe('dry run', () => {
  it('runs the pipeline but never calls stage()', async () => {
    const stage = vi.fn(() => ({
      staged: 3,
      droppedDuplicates: 0,
      supersededRemoved: 0,
      dropped: []
    }))
    const { q } = makeQueue({ stage })
    createCase(db, home, { title: 'A', slug: 'a' })
    const job = q.enqueueDryRun('a')
    await q.idle()
    expect(stage).not.toHaveBeenCalled()
    const row = db.prepare(`SELECT * FROM distill_jobs WHERE id = ?`).get(job.id) as {
      state: string
      item_count: number | null
      dry_run: number
      raw_output: string | null
    }
    expect(row.state).toBe('done')
    // NULL, not 0: staging never ran, as distinct from ran and staged nothing.
    expect(row.item_count).toBeNull()
    expect(row.dry_run).toBe(1)
    expect(row.raw_output).not.toBeNull()
  })

  it('passes ignorePriorProposals through to assembleInput', () => {
    const assembleInput = vi.fn(() => INPUT)
    const { q } = makeQueue({ assembleInput })
    createCase(db, home, { title: 'A', slug: 'a' })
    q.enqueueDryRun('a', { ignorePriorProposals: true })
    expect(assembleInput).toHaveBeenCalledWith('a', { ignorePriorProposals: true })
  })

  it('does not queue a reject-digest rebuild', async () => {
    // A digest rebuild writes a GLOBAL file; a comparison run must not rewrite standing guidance.
    archiveReject(home, 'r1')
    archiveReject(home, 'r2')
    archiveReject(home, 'r3')
    archiveReject(home, 'r4')
    archiveReject(home, 'r5')
    const { q } = makeQueue({ listArchivedProposalsFn: () => listArchivedProposals(home) })
    createCase(db, home, { title: 'A', slug: 'a' })
    q.enqueueDryRun('a')
    await q.idle()
    const digest = db
      .prepare(`SELECT COUNT(*) AS n FROM distill_jobs WHERE kind='reject-digest'`)
      .get() as { n: number }
    expect(digest.n).toBe(0)
  })

  it('statusFor ignores a newer dry row and returns the real job', async () => {
    const { q } = makeQueue()
    createCase(db, home, { title: 'A', slug: 'a' })
    const real = q.enqueue('a')
    await q.idle()
    q.enqueueDryRun('a')
    await q.idle()
    expect(q.statusFor('a')!.id).toBe(real.id)
  })

  it('needsDistillRun stays true when the only completed run is dry', async () => {
    const { q } = makeQueue()
    createCase(db, home, { title: 'A', slug: 'a' })
    q.enqueueDryRun('a')
    await q.idle()
    expect(needsDistillRun(db, q, 'a')).toBe(true)
  })

  it('listRuns still includes dry rows — the picker compares them', async () => {
    const { q } = makeQueue()
    createCase(db, home, { title: 'A', slug: 'a' })
    q.enqueue('a')
    await q.idle()
    const dry = q.enqueueDryRun('a')
    await q.idle()
    expect(q.listRuns('a').map((r) => r.id)).toContain(dry.id)
    expect(q.listRuns('a').find((r) => r.id === dry.id)!.dryRun).toBe(true)
  })

  it('a dry run occupies the in-flight slot: enqueuing a real distill while it is queued/running cancels it via the existing one-job-per-case path (spec: "A dry run occupies the in-flight slot")', async () => {
    const { q } = makeQueue({ distill: () => new Promise(() => {}) /* never resolves */ })
    createCase(db, home, { title: 'A', slug: 'a' })
    const dry = q.enqueueDryRun('a')
    await vi.waitFor(
      () =>
        expect(
          (
            db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(dry.id) as {
              state: string
            }
          ).state
        ).toBe('running'),
      { timeout: 5000 }
    )

    const real = q.enqueue('a')

    const dryRow = db.prepare(`SELECT state, dry_run FROM distill_jobs WHERE id=?`).get(dry.id) as {
      state: string
      dry_run: number
    }
    expect(dryRow.state).toBe('cancelled')
    expect(dryRow.dry_run).toBe(1) // cancelling didn't quietly convert it into a real row
    const inFlight = db
      .prepare(`SELECT id FROM distill_jobs WHERE case_slug='a' AND state IN ('queued','running')`)
      .all() as { id: number }[]
    expect(inFlight.map((r) => r.id)).toEqual([real.id])
  })

  it("refuses to enqueue while a REAL job is already in-flight, rather than silently cancelling it (regression: enqueueDryRun called cancelOtherInFlight unconditionally, so a stale renderer — e.g. one whose broadcast was dropped by emit()'s deliberate swallow of webContents.send failures — could silently abort a real run in another window; mirrors retry()'s own in-flight guard)", async () => {
    const { q } = makeQueue({ distill: () => new Promise(() => {}) /* never resolves */ })
    createCase(db, home, { title: 'A', slug: 'a' })
    const real = q.enqueue('a')
    await vi.waitFor(() => expect(q.statusFor('a')!.state).toBe('running'), { timeout: 5000 })

    expect(() => q.enqueueDryRun('a')).toThrow(/already has an in-flight job/i)

    // The real job must be untouched — still running, not cancelled by the refused attempt.
    const row = db.prepare(`SELECT state, dry_run FROM distill_jobs WHERE id=?`).get(real.id) as {
      state: string
      dry_run: number
    }
    expect(row.state).toBe('running')
    expect(row.dry_run).toBe(0)
  })

  it('refuses to enqueue a second dry run while one is already queued/running for the same case', async () => {
    const { q } = makeQueue({ distill: () => new Promise(() => {}) /* never resolves */ })
    createCase(db, home, { title: 'A', slug: 'a' })
    const first = q.enqueueDryRun('a')
    await vi.waitFor(
      () =>
        expect(
          (
            db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(first.id) as {
              state: string
            }
          ).state
        ).toBe('running'),
      { timeout: 5000 }
    )

    expect(() => q.enqueueDryRun('a')).toThrow(/already has an in-flight job/i)

    const row = db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(first.id) as {
      state: string
    }
    expect(row.state).toBe('running')
  })

  it('does not refuse a dry run for a DIFFERENT case just because another case has one in flight', async () => {
    const { q } = makeQueue({ distill: () => new Promise(() => {}) /* never resolves */ })
    createCase(db, home, { title: 'A', slug: 'a' })
    createCase(db, home, { title: 'B', slug: 'b' })
    q.enqueueDryRun('a')
    await vi.waitFor(() => expect(q.listRuns('a')[0]?.state).toBe('running'), { timeout: 5000 })
    expect(() => q.enqueueDryRun('b')).not.toThrow()
  })

  it('cancelling a dry run directly works — both while queued and while running (spec: "and cancelling the dry run works")', async () => {
    // One queue, one never-resolving `distill()` — the runner's single global execution slot
    // (kick() processes one job at a time across ALL slugs, see the class doc comment) stays
    // occupied by whichever job it picks up first and never lets go, which is what keeps the
    // SECOND case's dry run genuinely `queued` (not `running`) below.
    const { q } = makeQueue({ distill: () => new Promise(() => {}) })
    createCase(db, home, { title: 'A', slug: 'a' })
    createCase(db, home, { title: 'B', slug: 'b' })

    const running = q.enqueueDryRun('a')
    await vi.waitFor(
      () =>
        expect(
          (
            db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(running.id) as {
              state: string
            }
          ).state
        ).toBe('running'),
      { timeout: 5000 }
    )
    const cancelledRunning = q.cancel(running.id)
    expect(cancelledRunning.state).toBe('cancelled')
    expect(cancelledRunning.dryRun).toBe(true)

    // Case B's dry run stays QUEUED: the execution slot is still held by case A's runJob, which
    // is still awaiting the same never-resolving `distill()` call — cancel() flips the DB row
    // and aborts the controller, but this fake driver ignores the abort signal and never settles,
    // so kick()'s loop never advances to pick B up.
    const queued = q.enqueueDryRun('b')
    expect(
      (db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(queued.id) as { state: string })
        .state
    ).toBe('queued')
    const cancelledQueued = q.cancel(queued.id)
    expect(cancelledQueued.state).toBe('cancelled')
    expect(cancelledQueued.dryRun).toBe(true)
  })

  it('stamps the pipeline id on the row when the job starts running, from the per-call dep', async () => {
    const { q } = makeQueue({ pipelineId: () => 'v3' })
    q.enqueue('case-a')
    await q.idle()
    const row = db.prepare(`SELECT pipeline FROM distill_jobs WHERE case_slug='case-a'`).get() as {
      pipeline: string | null
    }
    expect(row.pipeline).toBe('v3')
  })

  it('retry() clears the pipeline stamp while the re-queued row waits for the slot', async () => {
    const { q } = makeQueue({
      pipelineId: () => 'v3',
      assembleInput: (slug) => ({ caseMeta: { slug } }) as unknown as CaseDistillInput,
      distill: async (input) => {
        const slug = (input as CaseDistillInput).caseMeta.slug
        if (slug === 'case-a') throw new DistillParseError('bad', 'RAW')
        return new Promise(() => {}) // case-b occupies the single in-flight slot forever
      }
    })
    q.enqueue('case-a')
    await q.idle()
    const failed = q.statusFor('case-a')!
    expect(failed.state).toBe('failed')
    const failedRow = db.prepare(`SELECT pipeline FROM distill_jobs WHERE id=?`).get(failed.id) as {
      pipeline: string | null
    }
    expect(failedRow.pipeline).toBe('v3') // sanity: the failed run really was stamped

    // Occupy the queue's single in-flight slot with an unrelated, never-resolving job BEFORE
    // retrying, so the retried row cannot reach runJob's re-stamp — see the class doc comment
    // and the analogous idiom in "retry() resets every v2 column to NULL..." above.
    q.enqueue('case-b')
    await vi.waitFor(() => expect(q.statusFor('case-b')!.state).toBe('running'), {
      timeout: 5000
    })

    q.retry(failed.id)
    const row = db
      .prepare(`SELECT state, pipeline FROM distill_jobs WHERE id=?`)
      .get(failed.id) as { state: string; pipeline: string | null }
    expect(row.state).toBe('queued')
    expect(row.pipeline).toBeNull()
  })

  it('listAllRuns: every case job across cases, newest first, joined to case title/jira, digest rows excluded, dry rows included', async () => {
    createCase(db, home, { slug: 'case-a', title: 'Alpha', jiraKey: 'NAV-1' })
    const { q } = makeQueue({ pipelineId: () => 'v3' })
    q.enqueue('case-a')
    await q.idle()
    q.enqueueDryRun('case-a')
    await q.idle()
    q.enqueue('case-b') // no cases row: title falls back to the slug
    await q.idle()
    db.prepare(
      `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, kind) VALUES (?, 'done', '{}', 'x', 'reject-digest')`
    ).run(DIGEST_CASE_SLUG)
    const rows = q.listAllRuns()
    expect(rows.map((r) => r.caseSlug)).toEqual(['case-b', 'case-a', 'case-a'])
    expect(rows[1].dryRun).toBe(true)
    expect(rows[1].caseTitle).toBe('Alpha')
    expect(rows[1].jiraKey).toBe('NAV-1')
    expect(rows[0].caseTitle).toBe('case-b')
    expect(rows[0].jiraKey).toBeNull()
    expect(rows.every((r) => r.pipeline === 'v3')).toBe(true)
    expect(rows.every((r) => r.progress === undefined)).toBe(true)
  })

  it('listAllRuns honours limit and falls back pipeline from stages_json for a pre-column row', () => {
    for (let i = 0; i < 3; i++)
      db.prepare(
        `INSERT INTO distill_jobs (case_slug, state, input_snapshot, created_at, stages_json) VALUES ('c', 'done', '{}', 'x', ?)`
      ).run(i === 0 ? '{"dossier":{}}' : null)
    const { q } = makeQueue()
    expect(q.listAllRuns(2)).toHaveLength(2)
    const all = q.listAllRuns()
    expect(all.map((r) => r.pipeline)).toEqual(['v2', 'v2', 'v3'])
  })
})

describe('pipelineOf', () => {
  it('prefers the stamped column', () => {
    expect(pipelineOf({ pipeline: 'v2', has_stages: true, state: 'done' })).toBe('v2')
  })
  it('falls back to v3 when a pre-column row carries stages_json', () => {
    expect(pipelineOf({ pipeline: null, has_stages: true, state: 'done' })).toBe('v3')
  })
  it('falls back to v2 for a terminal pre-column row with no stages', () => {
    expect(pipelineOf({ pipeline: null, has_stages: false, state: 'done' })).toBe('v2')
    expect(pipelineOf({ pipeline: null, has_stages: false, state: 'failed' })).toBe('v2')
    expect(pipelineOf({ pipeline: null, has_stages: false, state: 'cancelled' })).toBe('v2')
  })
  it('is null for a queued/running row that has not been stamped', () => {
    expect(pipelineOf({ pipeline: null, has_stages: false, state: 'queued' })).toBeNull()
    expect(pipelineOf({ pipeline: null, has_stages: false, state: 'running' })).toBeNull()
  })
  it('ignores an unknown column value rather than trusting it', () => {
    expect(pipelineOf({ pipeline: 'v9', has_stages: false, state: 'done' })).toBe('v2')
  })
})

describe('attribution', () => {
  const ATTR_RUN = {
    raw: '```json\n{}\n```',
    output: { proposals: [] },
    stages: {
      dossier: { promptHash: 'h', promptChars: 1, rawOutput: '' },
      attribution: { promptHash: 'a', promptChars: 1, rawOutput: '' }
    },
    attribution: {
      verdicts: [
        {
          kind: 'skill' as const,
          name: 'diag',
          applied: true,
          verdict: 'helped' as const,
          reason: 'r',
          cites: []
        }
      ],
      malformedDropped: {},
      unknownAssetDropped: {},
      uncitedDropped: 0,
      duplicateDropped: 0
    }
  }
  const ATTR_INPUT = {
    ...INPUT,
    caseOutcome: 'solved',
    caseDomain: 'NAV',
    assets: [
      {
        kind: 'skill',
        name: 'diag',
        tier: 'user',
        callCount: 1,
        firstSeen: { sessionId: 1, turnId: null }
      }
    ],
    options: { attribution: true }
  } as unknown as CaseDistillInput
  const EMPTY_ONLY = async (): Promise<{
    stages: Record<string, never>
    promptChars: number
    turnCount: number
    toolCallCount: number
    trajectory: never[]
  }> => ({ stages: {}, promptChars: 0, turnCount: 0, toolCallCount: 0, trajectory: [] })
  const attrCount = (): number =>
    (
      db.prepare(`SELECT COUNT(*) AS n FROM distill_jobs WHERE kind='attribution'`).get() as {
        n: number
      }
    ).n

  it('writes asset_attributions rows after a done case job and calls onAttributions', async () => {
    createCase(db, home, { slug: 'case-a', title: 'T' })
    const emitted: unknown[] = []
    const { q } = makeQueue({
      assembleInput: () => ATTR_INPUT,
      distill: async () => ATTR_RUN,
      judgeModel: () => 'm1',
      onAttributions: (rows) => emitted.push(...rows)
    })
    q.enqueue('case-a', { attribution: true })
    await q.idle()
    const rows = db
      .prepare(`SELECT asset_name, verdict, judge_model, case_domain FROM asset_attributions`)
      .all()
    expect(rows).toEqual([
      { asset_name: 'diag', verdict: 'helped', judge_model: 'm1', case_domain: 'NAV' }
    ])
    expect(emitted).toHaveLength(1)
    expect(attrCount()).toBe(0)
  })
  it('the rows are written before the done broadcast lands', async () => {
    createCase(db, home, { slug: 'case-a', title: 'T' })
    const seenAtDone: number[] = []
    const { q } = makeQueue({
      assembleInput: () => ATTR_INPUT,
      distill: async () => ATTR_RUN,
      broadcast: (p: DistillStatusPayload) => {
        if (p.job?.state === 'done')
          seenAtDone.push(
            (db.prepare(`SELECT COUNT(*) AS n FROM asset_attributions`).get() as { n: number }).n
          )
      }
    })
    q.enqueue('case-a', { attribution: true })
    await q.idle()
    expect(seenAtDone).toEqual([1])
  })
  it('a dry run writes no rows and never triggers the escape hatch', async () => {
    createCase(db, home, { slug: 'case-a', title: 'T' })
    const { q } = makeQueue({ assembleInput: () => ATTR_INPUT, distill: async () => ATTR_RUN })
    q.enqueueDryRun('case-a')
    await q.idle()
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM asset_attributions`).get() as { n: number }).n
    ).toBe(0)
    const { q: q2 } = makeQueue({
      assembleInput: () => ATTR_INPUT,
      distill: async () => ({ raw: '```json\n{}\n```', output: { proposals: [] } }),
      attributeOnly: EMPTY_ONLY
    })
    q2.enqueueDryRun('case-a')
    await q2.idle()
    expect(attrCount()).toBe(0)
  })
  it('enqueue(slug, {attribution}) forwards the choice to assembleInput', () => {
    const assembleInput = vi.fn(() => INPUT)
    const { q } = makeQueue({ assembleInput })
    q.enqueue('case-a', { attribution: false })
    expect(assembleInput).toHaveBeenCalledWith('case-a', { attribution: false })
  })
  it('reconcileAndEnqueue forwards opts to enqueue', () => {
    const assembleInput = vi.fn(() => INPUT)
    const { q } = makeQueue({ assembleInput })
    reconcileAndEnqueue(q, 'case-a', { attribution: false })
    expect(assembleInput).toHaveBeenCalledWith('case-a', { attribution: false })
  })
  it('a row-write failure never fails the case job (emission failures never block the pipeline)', async () => {
    // No case row → writeAttributions throws "Unknown case".
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onAttributions = vi.fn()
    const { q } = makeQueue({
      assembleInput: () => ATTR_INPUT,
      distill: async () => ATTR_RUN,
      onAttributions
    })
    q.enqueue('case-a', { attribution: true })
    await q.idle()
    errSpy.mockRestore()
    expect(q.statusFor('case-a')!.state).toBe('done')
    expect(onAttributions).not.toHaveBeenCalled()
  })
  it('an onAttributions throw is swallowed — it fails neither a case job nor an attribution job', async () => {
    createCase(db, home, { slug: 'case-a', title: 'T' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { q } = makeQueue({
      assembleInput: () => ATTR_INPUT,
      distill: async () => ATTR_RUN,
      attributeOnly: async () => ({
        stages: ATTR_RUN.stages,
        attribution: ATTR_RUN.attribution,
        promptChars: 1,
        turnCount: 1,
        toolCallCount: 0,
        trajectory: []
      }),
      onAttributions: () => {
        throw new Error('renderer gone')
      }
    })
    q.enqueue('case-a', { attribution: true })
    await q.idle()
    const a = q.enqueueAttribution('case-a')
    await q.idle()
    errSpy.mockRestore()
    expect(q.statusFor('case-a')!.state).toBe('done')
    expect(db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(a.id)).toEqual({
      state: 'done'
    })
  })

  describe('escape hatch', () => {
    const failing = async (): Promise<never> => {
      throw new DistillAgentRunError('dossier: boom', '', {
        stages: { dossier: { promptHash: 'h', promptChars: 1, rawOutput: '', error: 'boom' } }
      })
    }
    it.each([
      ['dossier failure', failing],
      [
        // A late failure whose agentMeta carries NO parsed verdicts (stages only) still hatches:
        // there is nothing to write, so the verdicts have to come from a fresh run.
        'late failure without carried verdicts',
        async (): Promise<never> => {
          throw new DistillAgentRunError('candidates: bad', '', { stages: ATTR_RUN.stages })
        }
      ],
      [
        'attribution stage error',
        async () => ({
          ...ATTR_RUN,
          attribution: undefined,
          stages: {
            ...ATTR_RUN.stages,
            attribution: { promptHash: 'a', promptChars: 1, rawOutput: 'x', error: 'bad' }
          }
        })
      ],
      ['v2 run (no stages)', async () => ({ raw: '```json\n{}\n```', output: { proposals: [] } })]
    ])('%s enqueues exactly one attribution job', async (_n, distill) => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const assembleInput = vi.fn(() => ATTR_INPUT)
      const { q } = makeQueue({
        assembleInput,
        distill: distill as never,
        attributeOnly: EMPTY_ONLY
      })
      q.enqueue('case-a', { attribution: true })
      await q.idle()
      const kinds = db
        .prepare(`SELECT kind, state FROM distill_jobs WHERE case_slug='case-a' ORDER BY id`)
        .all() as { kind: string; state: string }[]
      expect(kinds.filter((k) => k.kind === 'attribution')).toEqual([
        { kind: 'attribution', state: 'done' }
      ])
      expect(assembleInput).toHaveBeenLastCalledWith('case-a', { attribution: true })
    })
    it('does not enqueue one when the job declined attribution, or when the case job succeeded with the stage', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const { q } = makeQueue({
        assembleInput: () => ({ ...ATTR_INPUT, options: { attribution: false } }),
        distill: failing
      })
      q.enqueue('case-a', { attribution: false })
      await q.idle()
      const { q: q2 } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: async () => ATTR_RUN
      })
      q2.enqueue('case-a', { attribution: true })
      await q2.idle()
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM distill_jobs WHERE kind='attribution'`).get()
      ).toEqual({ n: 0 })
    })
    it('does not enqueue one for an empty inventory (no-assets marker, or a failed/v2 run with no assets)', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const noAssets = { ...ATTR_INPUT, assets: [] } as unknown as CaseDistillInput
      const { q } = makeQueue({
        assembleInput: () => noAssets,
        distill: async () => ({
          ...ATTR_RUN,
          attribution: undefined,
          stages: { dossier: ATTR_RUN.stages.dossier, attributionSkipped: 'no-assets' as const }
        })
      })
      q.enqueue('case-a', { attribution: true })
      await q.idle()
      const { q: q2 } = makeQueue({ assembleInput: () => noAssets, distill: failing })
      q2.enqueue('case-a', { attribution: true })
      await q2.idle()
      const { q: q3 } = makeQueue({
        assembleInput: () => noAssets,
        distill: async () => ({ raw: '```json\n{}\n```', output: { proposals: [] } })
      })
      q3.enqueue('case-a', { attribution: true })
      await q3.idle()
      expect(attrCount()).toBe(0)
    })
    it('does not enqueue one for an OPEN case (failed, v2, or open-skipped run) (A7)', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const open = { ...ATTR_INPUT, caseOutcome: 'open' } as unknown as CaseDistillInput
      const { q } = makeQueue({ assembleInput: () => open, distill: failing })
      q.enqueue('case-a', { attribution: true })
      await q.idle()
      const { q: q2 } = makeQueue({
        assembleInput: () => open,
        distill: async () => ({ raw: '```json\n{}\n```', output: { proposals: [] } })
      })
      q2.enqueue('case-a', { attribution: true })
      await q2.idle()
      // A snapshot whose outcome is not 'open' but whose run recorded the open skip still
      // never hatches (the marker alone is enough).
      const { q: q3 } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: async () => ({
          ...ATTR_RUN,
          attribution: undefined,
          stages: { dossier: ATTR_RUN.stages.dossier, attributionSkipped: 'open' as const }
        })
      })
      q3.enqueue('case-a', { attribution: true })
      await q3.idle()
      expect(attrCount()).toBe(0)
    })
    it('a cancelled case job does not trigger it', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: async () => {
          await gate
          throw new DistillAgentRunError('dossier: boom', '', {})
        },
        attributeOnly: EMPTY_ONLY
      })
      const job = q.enqueue('case-a', { attribution: true })
      await vi.waitFor(() => expect(q.statusFor('case-a')!.state).toBe('running'))
      q.cancel(job.id)
      release()
      await q.idle()
      expect(attrCount()).toBe(0)
    })
    it('a failing attribution job never enqueues another one (no hatch loop)', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: failing,
        attributeOnly: async () => {
          throw new DistillAgentRunError('dossier: boom again', '', {
            stages: { dossier: { promptHash: 'h', promptChars: 1, rawOutput: '', error: 'x' } }
          })
        }
      })
      q.enqueue('case-a', { attribution: true })
      await q.idle()
      const rows = db
        .prepare(
          `SELECT kind, state, stages_json FROM distill_jobs WHERE case_slug='case-a' ORDER BY id`
        )
        .all() as { kind: string; state: string; stages_json: string | null }[]
      expect(rows.map((r) => [r.kind, r.state])).toEqual([
        ['case', 'failed'],
        ['attribution', 'failed']
      ])
      // The DistillAgentRunError catch persists the failing stage on the attribution row too.
      expect(JSON.parse(rows[1].stages_json!).dossier.error).toBe('x')
    })
    it('a late failure that carries its verdicts writes the rows and does not hatch', async () => {
      // candidates fails AFTER the attribution stage succeeded; the pipeline carries the parsed
      // verdicts on agentMeta, so the queue writes them instead of paying for a second run.
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const emitted: unknown[] = []
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: async () => {
          throw new DistillAgentRunError('candidates: bad', '', {
            stages: ATTR_RUN.stages,
            attribution: ATTR_RUN.attribution
          })
        },
        attributeOnly: EMPTY_ONLY,
        judgeModel: () => 'm1',
        onAttributions: (rows) => emitted.push(...rows)
      })
      const job = q.enqueue('case-a', { attribution: true })
      await q.idle()
      expect(q.statusFor('case-a')!.state).toBe('failed')
      expect(
        db.prepare(`SELECT job_id, asset_name, verdict, judge_model FROM asset_attributions`).all()
      ).toEqual([{ job_id: job.id, asset_name: 'diag', verdict: 'helped', judge_model: 'm1' }])
      expect(emitted).toHaveLength(1)
      expect(attrCount()).toBe(0)
    })
    it('a dry run that fails with DistillAgentRunError writes no rows and never hatches', async () => {
      // The only path where maybeEscapeHatch's dry_run guard is load-bearing: the catch branch
      // runs for dry and real rows alike. Carried verdicts make persistAttribution's guard
      // load-bearing too.
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: async () => {
          throw new DistillAgentRunError('candidates: bad', '', {
            stages: ATTR_RUN.stages,
            attribution: ATTR_RUN.attribution
          })
        },
        attributeOnly: EMPTY_ONLY
      })
      const dry = q.enqueueDryRun('case-a')
      await q.idle()
      expect(db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(dry.id)).toEqual({
        state: 'failed'
      })
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM asset_attributions`).get() as { n: number }).n
      ).toBe(0)
      expect(attrCount()).toBe(0)
    })
    it('a dry run that fails with no carried verdicts still never hatches', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: failing,
        attributeOnly: EMPTY_ONLY
      })
      q.enqueueDryRun('case-a')
      await q.idle()
      expect(attrCount()).toBe(0)
    })
    it('retry() of the failed case job cancels its hatched attribution job and re-runs the case', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let distillCalls = 0
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: async () => {
          distillCalls++
          if (distillCalls === 1) return failing()
          return ATTR_RUN
        },
        attributeOnly: async () => {
          await gate
          return { stages: {}, promptChars: 0, turnCount: 0, toolCallCount: 0, trajectory: [] }
        }
      })
      const job = q.enqueue('case-a', { attribution: true })
      const hatch = (): { id: number; state: string } | undefined =>
        db.prepare(`SELECT id, state FROM distill_jobs WHERE kind='attribution'`).get() as
          { id: number; state: string } | undefined
      await vi.waitFor(() => expect(hatch()?.state).toBe('running'))
      expect(q.statusFor('case-a')!.state).toBe('failed')
      expect(() => q.retry(job.id)).not.toThrow()
      // A retried case run re-runs the attribution stage itself: the hatch job is redundant.
      expect(hatch()?.state).toBe('cancelled')
      release()
      await q.idle()
      expect(distillCalls).toBe(2)
      expect(q.statusFor('case-a')).toMatchObject({ id: job.id, state: 'done' })
      expect(hatch()?.state).toBe('cancelled')
      expect(attrCount()).toBe(1)
      expect(
        db.prepare(`SELECT job_id FROM asset_attributions`).all() as { job_id: number }[]
      ).toEqual([{ job_id: job.id }])
    })
    it('retry() of a failed case job also cancels a still-QUEUED hatched attribution job', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let distillCalls = 0
      const { q } = makeQueue({
        assembleInput: (slug) => (slug === 'other' ? INPUT : ATTR_INPUT),
        distill: async (input) => {
          // "other" (no assets) holds the runner so the hatch row, inserted after it, stays queued.
          if ((input.assets ?? []).length === 0) {
            await gate
            return ATTR_RUN
          }
          distillCalls++
          if (distillCalls === 1) return failing()
          return ATTR_RUN
        },
        attributeOnly: EMPTY_ONLY
      })
      const job = q.enqueue('case-a', { attribution: true })
      q.enqueue('other', { attribution: false })
      const hatch = (): { id: number; state: string } | undefined =>
        db.prepare(`SELECT id, state FROM distill_jobs WHERE kind='attribution'`).get() as
          { id: number; state: string } | undefined
      await vi.waitFor(() => expect(hatch()?.state).toBe('queued'))
      expect(q.statusFor('case-a')!.state).toBe('failed')
      expect(() => q.retry(job.id)).not.toThrow()
      expect(hatch()?.state).toBe('cancelled')
      release()
      await q.idle()
      expect(q.statusFor('case-a')).toMatchObject({ id: job.id, state: 'done' })
      expect(attrCount()).toBe(1)
    })
    it('a dry run is neither refused by nor cancels a background attribution job', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        distill: async () => ATTR_RUN,
        attributeOnly: async () => {
          await gate
          return { stages: {}, promptChars: 0, turnCount: 0, toolCallCount: 0, trajectory: [] }
        }
      })
      const a = q.enqueueAttribution('case-a')
      const state = (id: number): unknown =>
        (db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(id) as { state: string }).state
      await vi.waitFor(() => expect(state(a.id)).toBe('running'))
      let dryId = -1
      expect(() => (dryId = q.enqueueDryRun('case-a').id)).not.toThrow()
      expect(state(a.id)).toBe('running')
      release()
      await q.idle()
      expect(state(a.id)).toBe('done')
      expect(state(dryId)).toBe('done')
    })
  })

  describe('attribution job', () => {
    it('runs attributeOnly, persists stages+usage on its own row, writes rows, and is not retried automatically on failure', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      const { q, broadcasts } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        attributeOnly: async () => ({
          stages: ATTR_RUN.stages,
          attribution: ATTR_RUN.attribution,
          usage: { costUsd: 0.3, durationMs: 5 },
          promptChars: 12,
          turnCount: 2,
          toolCallCount: 1,
          trajectory: []
        })
      })
      const job = q.enqueueAttribution('case-a')
      await q.idle()
      const row = db
        .prepare(`SELECT kind, state, cost_usd, stages_json FROM distill_jobs WHERE id=?`)
        .get(job.id) as { kind: string; state: string; cost_usd: number; stages_json: string }
      expect(row).toMatchObject({ kind: 'attribution', state: 'done', cost_usd: 0.3 })
      expect(JSON.parse(row.stages_json).attribution).toBeDefined()
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM asset_attributions WHERE job_id=?`).get(job.id) as {
            n: number
          }
        ).n
      ).toBe(1)
      // attribution rows never drive the case chip: no distill:changed broadcast for this kind
      expect(broadcasts).toHaveLength(0)
      const { q: q2 } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        attributeOnly: async () => {
          throw new Error('boom')
        }
      })
      const failed = q2.enqueueAttribution('case-a')
      await q2.idle()
      expect(db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(failed.id)).toEqual({
        state: 'failed'
      })
      expect(attrCount()).toBe(2)
    })
    it('an attribution stage that errored (no output) fails the job, keeps stages+cost, and is retryable (A3)', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let calls = 0
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        attributeOnly: async () => {
          calls++
          return {
            stages: {
              attribution: {
                promptHash: 'p',
                promptChars: 9,
                rawOutput: 'no fence',
                error: 'expected exactly 1 json fence, got 0'
              }
            },
            usage: { costUsd: 0.2, durationMs: 5 },
            promptChars: 9,
            turnCount: 1,
            toolCallCount: 0,
            trajectory: []
          }
        }
      })
      const job = q.enqueueAttribution('case-a')
      await q.idle()
      const row = db
        .prepare(`SELECT state, error, cost_usd, stages_json FROM distill_jobs WHERE id=?`)
        .get(job.id) as { state: string; error: string; cost_usd: number; stages_json: string }
      expect(row.state).toBe('failed')
      expect(row.error).toBe('attribution: expected exactly 1 json fence, got 0')
      expect(row.cost_usd).toBe(0.2)
      expect(JSON.parse(row.stages_json).attribution.error).toMatch(/json fence/)
      expect(() => q.retry(job.id)).not.toThrow()
      await q.idle()
      expect(calls).toBe(2)
    })
    it('snapshots with attribution forced on', () => {
      const assembleInput = vi.fn(() => ATTR_INPUT)
      const { q } = makeQueue({ assembleInput, attributeOnly: EMPTY_ONLY })
      q.enqueueAttribution('case-a')
      expect(assembleInput).toHaveBeenCalledWith('case-a', { attribution: true })
    })
    it('a row-write failure fails the attribution job but keeps its stages and cost', async () => {
      // No case row → writeAttributions throws; this job exists only to write rows.
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        attributeOnly: async () => ({
          stages: ATTR_RUN.stages,
          attribution: ATTR_RUN.attribution,
          usage: { costUsd: 0.3, durationMs: 5 },
          promptChars: 12,
          turnCount: 2,
          toolCallCount: 1,
          trajectory: []
        })
      })
      const job = q.enqueueAttribution('case-a')
      await q.idle()
      const row = db
        .prepare(`SELECT state, error, cost_usd, stages_json FROM distill_jobs WHERE id=?`)
        .get(job.id) as { state: string; error: string; cost_usd: number; stages_json: string }
      expect(row.state).toBe('failed')
      expect(row.error).toMatch(/Unknown case/)
      expect(row.cost_usd).toBe(0.3)
      expect(JSON.parse(row.stages_json).attribution).toBeDefined()
    })
    it('dedups per slug while one is queued/running, and a redistill cancels a queued one', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        attributeOnly: async () => {
          await gate
          return { stages: {}, promptChars: 0, turnCount: 0, toolCallCount: 0, trajectory: [] }
        },
        distill: async () => ATTR_RUN
      })
      const first = q.enqueueAttribution('case-a')
      expect(() => q.enqueueAttribution('case-a')).toThrow(/already/)
      reconcileAndEnqueue(q, 'case-a', { attribution: true })
      release()
      await q.idle()
      expect(db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(first.id)).toEqual({
        state: 'cancelled'
      })
      expect(q.statusFor('case-a')!.state).toBe('done')
    })
    it('a redistill cancels a still-QUEUED attribution job too', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        // A case job for another slug holds the runner so the attribution job stays queued.
        distill: async () => {
          await gate
          return ATTR_RUN
        },
        attributeOnly: EMPTY_ONLY
      })
      q.enqueue('other', { attribution: false })
      const queued = q.enqueueAttribution('case-a')
      expect(q.listAllRuns().find((r) => r.id === queued.id)?.state).toBe('queued')
      reconcileAndEnqueue(q, 'case-a', { attribution: true })
      expect(db.prepare(`SELECT state FROM distill_jobs WHERE id=?`).get(queued.id)).toEqual({
        state: 'cancelled'
      })
      release()
      await q.idle()
    })
    it('retry() accepts an attribution job; listAllRuns lists it with kind', async () => {
      createCase(db, home, { slug: 'case-a', title: 'T' })
      let calls = 0
      const { q } = makeQueue({
        assembleInput: () => ATTR_INPUT,
        // A case-pipeline hash IS configured: the attribution row must still never carry it.
        promptHash: () => 'case-hash',
        attributeOnly: async () => {
          calls++
          if (calls === 1) throw new Error('boom')
          return {
            stages: ATTR_RUN.stages,
            attribution: ATTR_RUN.attribution,
            promptChars: 1,
            turnCount: 1,
            toolCallCount: 0,
            trajectory: []
          }
        }
      })
      const j = q.enqueueAttribution('case-a')
      await q.idle()
      const read = (): { state: string; finished_at: string | null; prompt_hash: string | null } =>
        db
          .prepare(`SELECT state, finished_at, prompt_hash FROM distill_jobs WHERE id=?`)
          .get(j.id) as { state: string; finished_at: string | null; prompt_hash: string | null }
      const first = read()
      expect(first.state).toBe('failed')
      expect(first.finished_at).not.toBeNull()
      expect(() => q.retry(j.id)).not.toThrow()
      // Reset to a clean row (retry kicks synchronously, so it already reads 'running'): no stale
      // finished_at, and no case-pipeline hash stamped.
      expect(read()).toEqual({ state: 'running', finished_at: null, prompt_hash: null })
      await q.idle()
      expect(calls).toBe(2)
      const second = read()
      expect(second.state).toBe('done')
      expect(second.prompt_hash).toBeNull()
      expect(second.finished_at).not.toBeNull()
      expect(second.finished_at! >= first.finished_at!).toBe(true)
      const rows = q.listAllRuns()
      expect(rows.find((r) => r.id === j.id)?.kind).toBe('attribution')
    })
  })
})

describe('routeCaseClose', () => {
  it.each([
    [{ distill: true, attribution: true }, [['case', 'a', { attribution: true }]]],
    [{ distill: true, attribution: false }, [['case', 'a', { attribution: false }]]],
    [{ distill: false, attribution: true }, [['attribution', 'a']]],
    [{ distill: false, attribution: false }, []]
  ])('%o routes to %j', (opts, expected) => {
    const calls: unknown[][] = []
    routeCaseClose(
      opts,
      {
        enqueueCase: (slug, o) => calls.push(['case', slug, o]),
        enqueueAttribution: (slug) => calls.push(['attribution', slug])
      },
      'a'
    )
    expect(calls).toEqual(expected)
  })
})
