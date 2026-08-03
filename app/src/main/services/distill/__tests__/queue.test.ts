import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { DistillQueue } from '../queue'
import { DistillParseError } from '../contract'
import type { CaseDistillInput, DistillStatusPayload } from '../../../../shared/distill'

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
    const second = q.cancel(job.id)
    expect(second.state).toBe('cancelled')
    expect(second.finishedAt).toBe(first.finishedAt)
    await q.idle()
    expect(q.statusFor('case-a')!.finishedAt).toBe(first.finishedAt)
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
})
