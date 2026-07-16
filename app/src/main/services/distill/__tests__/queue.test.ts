import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { DistillQueue } from '../queue'
import { DistillParseError } from '../contract'
import type { CaseDistillInput } from '../../../../shared/distill'

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

  it('retry on a non-failed job throws', async () => {
    const { q } = makeQueue()
    const job = q.enqueue('case-a')
    await q.idle()
    expect(() => q.retry(job.id)).toThrow(/not failed/i)
  })
})
