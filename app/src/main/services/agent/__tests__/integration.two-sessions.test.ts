import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { ingestArtifact } from '../../ingest'
import { AgentService } from '../registry'
import { AsyncQueue } from '../asyncQueue'
import { defaultAgentAccess } from '../../../../shared/agentAccess'
import type { CreateQueryFn } from '../session'
import type { AgentEvent } from '../../../../shared/agent-events'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync, events: AgentEvent[]
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-int-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  events = []
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('two concurrent case sessions', () => {
  it('interleaved streams stay case-bound; approvals cannot cross', async () => {
    for (const slug of ['NAV-1', 'NAV-2']) {
      createCase(db, argusHome, { slug, title: slug })
      const src = path.join(tmp, `${slug}.txt`)
      fs.writeFileSync(src, `${slug} FATAL Navigator error\n`)
      ingestArtifact(db, argusHome, slug, src)
    }
    const queues = new Map<number, AsyncQueue<unknown>>()
    const canUseTools: Array<
      (
        n: string,
        i: Record<string, unknown>,
        o: { signal: AbortSignal }
      ) => Promise<{ behavior: string }>
    > = []
    let n = 0
    const createQuery: CreateQueryFn = (args) => {
      const q = new AsyncQueue<unknown>()
      queues.set(n++, q)
      canUseTools.push(args.options.canUseTool as never)
      return Object.assign(
        { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator]() },
        { interrupt: async () => q.end() }
      )
    }
    const svc = new AgentService({
      db,
      argusHome,
      skillsRoots: [],
      onEvent: (e) => events.push(e),
      agentAccess: () => defaultAgentAccess(),
      createQuery
    })

    await svc.send('NAV-1', '/analyze-applog evidence/NAV-1.txt')
    await svc.send('NAV-2', '/analyze-applog evidence/NAV-2.txt')

    // interleave assistant streams
    queues.get(0)!.push({
      type: 'stream_event',
      session_id: 'a',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'case1 ' } }
    })
    queues.get(1)!.push({
      type: 'stream_event',
      session_id: 'b',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'case2 ' } }
    })
    queues.get(0)!.push({
      type: 'assistant',
      session_id: 'a',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Crash at [evidence/NAV-1.txt:1]' }]
      }
    })
    await flush()

    const deltas = events.filter((e) => e.type === 'content.delta')
    expect(
      deltas.find((e) => (e.payload as { text: string }).text.includes('case1'))!.caseSlug
    ).toBe('NAV-1')
    expect(
      deltas.find((e) => (e.payload as { text: string }).text.includes('case2'))!.caseSlug
    ).toBe('NAV-2')

    // approval opened in NAV-2 cannot be answered through NAV-1
    const pend = canUseTools[1](
      'Bash',
      { command: 'git push' },
      { signal: new AbortController().signal }
    )
    await flush()
    const opened = events.find((e) => e.type === 'request.opened')!
    expect(opened.caseSlug).toBe('NAV-2')
    const reqId = (opened.payload as { requestId: string }).requestId
    expect(svc.respond('NAV-1', { requestId: reqId, kind: 'allow' })).toBe(false) // wrong case
    expect(svc.respond('NAV-2', { requestId: reqId, kind: 'deny' })).toBe(true)
    expect((await pend).behavior).toBe('deny')

    await svc.stopAll()
  })
})
