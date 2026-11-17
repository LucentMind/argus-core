import { createHash } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DatadogSink,
  datadogTraceId,
  evalLabel,
  hexToDecimalId,
  metaValue,
  modelProvider,
  rootSpanIdFromSeed,
  tag,
  type DatadogEval,
  type DatadogSinkOptions,
  type DatadogSpan
} from '../sink'
import { createDatadogIntake, failureDetail, intakeBase, type DatadogIntake } from '../intake'
import { datadogProvider, DATADOG_API_KEY_SECRET } from '..'
import type { ObservationIntent } from '../../../intent'

const SEED = 'argus-session-5@install-1'
const ROOT: ObservationIntent = {
  kind: 'trace-root',
  seed: SEED,
  name: 'case-a · session 5',
  caseSlug: 'case-a',
  metadata: { caseSlug: 'case-a', caseId: 9, nested: { a: 1 }, gone: null }
}

interface Fake {
  intake: DatadogIntake
  spanBodies: Array<{ data: { type: string; attributes: Record<string, unknown> } }>
  evalBodies: Array<{ data: { type: string; attributes: { metrics: DatadogEval[] } } }>
  spans: () => DatadogSpan[]
  evals: () => DatadogEval[]
  fail: (msg: string | null) => void
}

function fakeIntake(): Fake {
  const spanBodies: Fake['spanBodies'] = []
  const evalBodies: Fake['evalBodies'] = []
  let failing: string | null = null
  return {
    intake: {
      postSpans: async (b) => {
        if (failing) throw new Error(failing)
        spanBodies.push(b as Fake['spanBodies'][number])
      },
      postEvals: async (b) => {
        if (failing) throw new Error(failing)
        evalBodies.push(b as Fake['evalBodies'][number])
      }
    },
    spanBodies,
    evalBodies,
    spans: () => spanBodies.flatMap((b) => b.data.attributes.spans as DatadogSpan[]),
    evals: () => evalBodies.flatMap((b) => b.data.attributes.metrics),
    fail: (m) => {
      failing = m
    }
  }
}

const make = (over: Partial<DatadogSinkOptions> = {}): { sink: DatadogSink; fake: Fake } => {
  const fake = fakeIntake()
  const sink = new DatadogSink(fake.intake, {
    captureContent: false,
    mlApp: 'argus',
    tags: ['service:argus', 'version:1.0.0'],
    now: () => 1_700_000_000_000,
    ...over
  })
  return { sink, fake }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ids', () => {
  it('trace id is the shared 32-hex seed derivation', () => {
    const want = createHash('sha256').update(SEED).digest('hex').slice(0, 32)
    expect(datadogTraceId(SEED)).toBe(want)
    expect(datadogTraceId(SEED)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('root span id is the seed-derived 64-bit id as a positive decimal string', () => {
    const hex = createHash('sha256').update(SEED).digest('hex').slice(0, 16)
    const want = (BigInt(`0x${hex}`) & 0x7fffffffffffffffn).toString()
    expect(rootSpanIdFromSeed(SEED)).toBe(want)
    expect(rootSpanIdFromSeed(SEED)).toMatch(/^[1-9][0-9]*$/)
    expect(rootSpanIdFromSeed(SEED)).toBe(rootSpanIdFromSeed(SEED))
    expect(rootSpanIdFromSeed('other')).not.toBe(rootSpanIdFromSeed(SEED))
  })

  it('hexToDecimalId clears the sign bit and never yields zero', () => {
    expect(hexToDecimalId('ffffffffffffffff')).toBe('9223372036854775807')
    expect(hexToDecimalId('0000000000000000')).toBe('1')
    expect(hexToDecimalId('8000000000000000')).toBe('1')
    expect(hexToDecimalId('000000000000000a')).toBe('10')
  })
})

describe('mapping', () => {
  it('trace-root → agent span, parent "undefined", session = case slug, argus.* metadata', async () => {
    const { sink, fake } = make()
    sink.emit([ROOT, ROOT])
    await sink.flush()
    const [root, ...rest] = fake.spans()
    expect(rest).toHaveLength(0) // one root per seed
    expect(root).toMatchObject({
      name: 'case-a · session 5',
      span_id: rootSpanIdFromSeed(SEED),
      trace_id: datadogTraceId(SEED),
      parent_id: 'undefined',
      session_id: 'case-a',
      status: 'ok',
      duration: 1,
      start_ns: 1_700_000_000_000 * 1e6,
      meta: { kind: 'agent' }
    })
    expect(root.meta.metadata).toEqual({
      'argus.caseSlug': 'case-a',
      'argus.caseId': 9,
      'argus.nested': '{"a":1}',
      'argus.case.slug': 'case-a'
    })
    const body = fake.spanBodies[0]
    expect(body.data.type).toBe('span')
    expect(body.data.attributes.ml_app).toBe('argus')
    expect(body.data.attributes.tags).toEqual(['service:argus', 'version:1.0.0'])
  })

  it('generation → llm span with model, provider, token and cost metrics, timed from the intent', async () => {
    const { sink, fake } = make()
    sink.emit([
      ROOT,
      {
        kind: 'generation',
        seed: SEED,
        name: 'turn',
        model: 'claude-sonnet-5',
        startTime: 1000,
        endTime: 3500,
        usage: { input: 100, output: 40 },
        costUsd: 0.25,
        input: 'IN',
        output: 'OUT'
      }
    ])
    await sink.flush()
    const llm = fake.spans().find((s) => s.meta.kind === 'llm')!
    expect(llm).toMatchObject({
      name: 'turn',
      parent_id: rootSpanIdFromSeed(SEED),
      trace_id: datadogTraceId(SEED),
      session_id: 'case-a',
      start_ns: 1000 * 1e6,
      duration: 2500 * 1e6,
      meta: { kind: 'llm', model_name: 'claude-sonnet-5', model_provider: 'anthropic' },
      metrics: { input_tokens: 100, output_tokens: 40, total_tokens: 140, total_cost: 0.25 }
    })
    expect(llm.span_id).toMatch(/^[1-9][0-9]*$/)
    expect(llm.meta.input).toBeUndefined() // captureContent off
    expect(llm.meta.output).toBeUndefined()
  })

  it('generation content is sent as messages only with captureContent', async () => {
    const { sink, fake } = make({ captureContent: true })
    sink.emit([
      { kind: 'generation', seed: SEED, name: 'turn', model: 'gpt-x', input: 'IN', output: 'OUT' }
    ])
    await sink.flush()
    const llm = fake.spans()[0]
    expect(llm.meta.input).toEqual({ messages: [{ role: 'user', content: 'IN' }] })
    expect(llm.meta.output).toEqual({ messages: [{ role: 'assistant', content: 'OUT' }] })
    expect(llm.meta.model_provider).toBeUndefined() // not a Claude model, provider unknown
    expect(llm.metrics).toBeUndefined() // no usage, no cost
  })

  it('tool → tool span; an error sets status and meta.error; output only with captureContent', async () => {
    const off = make()
    off.sink.emit([
      { kind: 'tool', seed: SEED, name: 'read_file', isError: true, output: 'SECRET', startTime: 5 }
    ])
    await off.sink.flush()
    const t = off.fake.spans()[0]
    expect(t).toMatchObject({
      name: 'read_file',
      status: 'error',
      start_ns: 5e6,
      duration: 1,
      meta: { kind: 'tool', error: { message: 'tool read_file failed' } }
    })
    expect(JSON.stringify(off.fake.spanBodies)).not.toContain('SECRET')

    const on = make({ captureContent: true })
    on.sink.emit([{ kind: 'tool', seed: SEED, name: 'grep', isError: false, output: 'RESULT' }])
    await on.sink.flush()
    expect(on.fake.spans()[0]).toMatchObject({
      status: 'ok',
      meta: { kind: 'tool', output: { value: 'RESULT' } }
    })
    expect(on.fake.spans()[0].meta.error).toBeUndefined()
  })

  it('event → zero-length task span; level ERROR sets status and the message', async () => {
    const { sink, fake } = make()
    sink.emit([
      ROOT,
      { kind: 'event', seed: SEED, name: 'session resumed' },
      {
        kind: 'event',
        seed: SEED,
        name: 'session error',
        level: 'ERROR',
        metadata: { message: 'boom', counts: [1, 2] }
      }
    ])
    await sink.flush()
    const [resumed, error] = fake.spans().filter((s) => s.meta.kind === 'task')
    expect(resumed).toMatchObject({
      name: 'session resumed',
      status: 'ok',
      duration: 1,
      parent_id: rootSpanIdFromSeed(SEED),
      meta: { kind: 'task', metadata: { 'argus.level': 'DEFAULT' } }
    })
    expect(error).toMatchObject({
      name: 'session error',
      status: 'error',
      meta: {
        kind: 'task',
        error: { message: 'boom' },
        metadata: { message: 'boom', counts: '[1,2]', 'argus.level': 'ERROR' }
      }
    })
  })

  it('score → trace-scoped score evaluation joined to the root, tagged with metadata and the id', async () => {
    const { sink, fake } = make()
    sink.emit([
      {
        kind: 'score',
        seed: SEED,
        name: 'asset.contribution',
        value: -1,
        comment: 'misled the agent',
        id: 'abc123',
        metadata: {
          'argus.asset.name': 'skill-x',
          'argus.case.slug': 'case-a',
          n: 3,
          'gen_ai.evaluation.explanation': 'misled the agent'
        }
      }
    ])
    await sink.flush()
    expect(fake.spans()).toHaveLength(0)
    const body = fake.evalBodies[0]
    expect(body.data.type).toBe('evaluation_metric')
    const [e] = fake.evals()
    expect(e).toEqual({
      eval_scope: 'trace',
      join_on: { span: { span_id: rootSpanIdFromSeed(SEED), trace_id: datadogTraceId(SEED) } },
      ml_app: 'argus',
      timestamp_ms: 1_700_000_000_000,
      metric_type: 'score',
      label: 'asset_contribution',
      score_value: -1,
      reasoning: 'misled the agent',
      tags: [
        'service:argus',
        'version:1.0.0',
        'argus.asset.name:skill-x',
        'argus.case.slug:case-a',
        'n:3',
        'argus.score.name:asset.contribution',
        'argus.score.id:abc123'
      ]
    })
  })

  it('same-label scores on one trace in one millisecond get distinct timestamps (Datadog rejects duplicates)', async () => {
    const { sink, fake } = make() // now() is frozen
    sink.emit([
      { kind: 'score', seed: SEED, name: 'asset.contribution', value: 1, id: 'a' },
      { kind: 'score', seed: SEED, name: 'asset.contribution', value: 0, id: 'b' },
      { kind: 'score', seed: SEED, name: 'asset.contribution', value: -1, id: 'c' },
      { kind: 'score', seed: SEED, name: 'hitl_approved', value: 1 },
      { kind: 'score', seed: 'other-seed', name: 'asset.contribution', value: 1 }
    ])
    await sink.flush()
    const ts = fake
      .evals()
      .map((e) => [e.label, e.join_on.span.trace_id === datadogTraceId(SEED), e.timestamp_ms])
    const t0 = 1_700_000_000_000
    expect(ts).toEqual([
      ['asset_contribution', true, t0],
      ['asset_contribution', true, t0 + 1],
      ['asset_contribution', true, t0 + 2],
      ['hitl_approved', true, t0], // another label: no clash
      ['asset_contribution', false, t0] // another trace: no clash
    ])
  })

  it('a score with no comment and no id carries neither', async () => {
    const { sink, fake } = make()
    sink.emit([{ kind: 'score', seed: SEED, name: 'hitl_approved', value: 1 }])
    await sink.flush()
    const [e] = fake.evals()
    expect(e.reasoning).toBeUndefined()
    expect(e.label).toBe('hitl_approved')
    expect(e.tags.some((t) => t.startsWith('argus.score.id:'))).toBe(false)
  })
})

describe('restart parenting', () => {
  it('children and scores in a run with no root still join the root an earlier run sent', async () => {
    const first = make()
    first.sink.emit([ROOT])
    await first.sink.flush()
    const root = first.fake.spans()[0]

    // A fresh sink (app restart): no root intent this time.
    const second = make()
    second.sink.emit([
      { kind: 'tool', seed: SEED, name: 'grep', isError: false },
      { kind: 'score', seed: SEED, name: 'finding_accepted', value: 1 }
    ])
    await second.sink.flush()
    expect(second.fake.spans().filter((s) => s.parent_id === 'undefined')).toHaveLength(0)
    expect(second.fake.spans()[0].parent_id).toBe(root.span_id)
    expect(second.fake.spans()[0].trace_id).toBe(root.trace_id)
    expect(second.fake.evals()[0].join_on.span).toEqual({
      span_id: root.span_id,
      trace_id: root.trace_id
    })
  })
})

describe('batching', () => {
  it('buffers until flush: emit sends nothing synchronously', async () => {
    const { sink, fake } = make()
    sink.emit([ROOT, { kind: 'score', seed: SEED, name: 's', value: 1 }])
    expect(fake.spanBodies).toHaveLength(0)
    expect(fake.evalBodies).toHaveLength(0)
    await sink.flush()
    expect(fake.spanBodies).toHaveLength(1)
    expect(fake.evalBodies).toHaveLength(1)
    await sink.flush() // nothing buffered → nothing sent
    expect(fake.spanBodies).toHaveLength(1)
  })

  it('sends a chunk early once the record cap is reached', async () => {
    const { sink, fake } = make({ maxChunkRecords: 3 })
    const tools: ObservationIntent[] = Array.from({ length: 7 }, (_, i) => ({
      kind: 'tool' as const,
      seed: SEED,
      name: `t${i}`,
      isError: false
    }))
    sink.emit(tools)
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.spanBodies.map((b) => (b.data.attributes.spans as unknown[]).length)).toEqual([
      3, 3
    ])
    await sink.flush()
    expect(fake.spans().map((s) => s.name)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6'])
  })

  it('sends a chunk early once the byte cap is passed', async () => {
    const { sink, fake } = make({ captureContent: true, maxChunkBytes: 2_000 })
    sink.emit(
      Array.from({ length: 4 }, (_, i) => ({
        kind: 'tool' as const,
        seed: SEED,
        name: `t${i}`,
        isError: false,
        output: 'x'.repeat(900)
      }))
    )
    await sink.flush()
    expect(fake.spanBodies.length).toBe(2)
    for (const b of fake.spanBodies) expect(JSON.stringify(b).length).toBeLessThan(4_000)
  })

  it('sends on the timer without an explicit flush', async () => {
    vi.useFakeTimers()
    const { sink, fake } = make({ flushIntervalMs: 5_000 })
    sink.emit([ROOT])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fake.spanBodies).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.spanBodies).toHaveLength(1)
    await sink.shutdown()
  })
})

describe('errors', () => {
  it('a failed POST latches lastError; a later success clears it', async () => {
    const { sink, fake } = make()
    fake.fail('HTTP 403 · Forbidden')
    sink.emit([ROOT, { kind: 'score', seed: SEED, name: 's', value: 1 }])
    await sink.flush()
    // Latched per endpoint, and a later success on one must not clear the other's failure.
    expect(sink.lastError()).toBe('spans: HTTP 403 · Forbidden | evaluations: HTTP 403 · Forbidden')
    fake.fail(null)
    sink.emit([{ kind: 'score', seed: SEED, name: 's', value: 1 }])
    await sink.flush()
    expect(sink.lastError()).toBe('spans: HTTP 403 · Forbidden')
  })

  it('shutdown flushes what is buffered, is idempotent, and stops further sends', async () => {
    const { sink, fake } = make()
    sink.emit([ROOT])
    await sink.shutdown()
    expect(fake.spanBodies).toHaveLength(1)
    await sink.shutdown()
    sink.emit([{ kind: 'score', seed: SEED, name: 's', value: 1 }])
    await sink.flush()
    expect(fake.evalBodies).toHaveLength(0)
  })
})

describe('helpers', () => {
  it('metaValue keeps primitives, encodes objects, drops nullish', () => {
    expect(metaValue('a')).toBe('a')
    expect(metaValue(2)).toBe(2)
    expect(metaValue(false)).toBe(false)
    expect(metaValue(null)).toBeUndefined()
    expect(metaValue(undefined)).toBeUndefined()
    expect(metaValue({ a: [1] })).toBe('{"a":[1]}')
    expect(metaValue(Number.NaN)).toBe('NaN')
  })

  it('tag stringifies and caps at 200 characters', () => {
    expect(tag('k', 1)).toBe('k:1')
    expect(tag('k', null)).toBeNull()
    expect(tag('k', 'v'.repeat(300))!.length).toBe(200)
  })

  it('evalLabel follows Datadog label rules', () => {
    expect(evalLabel('asset.contribution')).toBe('asset_contribution')
    expect(evalLabel('proposal.outcome')).toBe('proposal_outcome')
    expect(evalLabel('hitl_approved')).toBe('hitl_approved')
    expect(evalLabel('1st')).toBe('argus_1st')
  })

  it('modelProvider infers anthropic for Claude models only', () => {
    expect(modelProvider('claude-opus-5-5')).toBe('anthropic')
    expect(modelProvider('gpt-5')).toBeUndefined()
  })
})

describe('intake', () => {
  it('posts to the right path with the API key header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const intake = createDatadogIntake({
      base: intakeBase('datadoghq.eu'),
      apiKey: 'KEY',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return new Response(null, { status: 202 })
      }
    })
    await intake.postSpans({ a: 1 })
    await intake.postEvals({ b: 2 })
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.datadoghq.eu/api/intake/llm-obs/v1/trace/spans',
      'https://api.datadoghq.eu/api/intake/llm-obs/v2/eval-metric'
    ])
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toMatchObject({
      'DD-API-KEY': 'KEY',
      'Content-Type': 'application/json'
    })
    expect(calls[0].init?.body).toBe('{"a":1}')
  })

  it('a non-2xx surfaces as HTTP <status> · <first error>', async () => {
    const intake = createDatadogIntake({
      base: 'http://relay.local/',
      apiKey: 'KEY',
      fetchImpl: async () =>
        new Response(JSON.stringify({ errors: ['Forbidden'] }), { status: 403 })
    })
    await expect(intake.postSpans({})).rejects.toThrow('HTTP 403 · Forbidden')
  })

  it('intakeBase: site default, override trimmed', () => {
    expect(intakeBase('us5.datadoghq.com')).toBe('https://api.us5.datadoghq.com')
    expect(intakeBase('datadoghq.com', 'http://127.0.0.1:9/')).toBe('http://127.0.0.1:9')
  })

  it('failureDetail reads errors objects, message bodies and plain text', async () => {
    expect(
      await failureDetail(new Response('{"errors":[{"detail":"bad span"}]}', { status: 400 }))
    ).toBe('HTTP 400 · bad span')
    expect(await failureDetail(new Response('{"message":"nope"}', { status: 401 }))).toBe(
      'HTTP 401 · nope'
    )
    expect(await failureDetail(new Response('gateway down\nmore', { status: 502 }))).toBe(
      'HTTP 502 · gateway down'
    )
    expect(await failureDetail(new Response('', { status: 500 }))).toBe('HTTP 500')
  })
})

describe('datadogProvider', () => {
  const secret = (v: string | null) => (n: string) => (n === DATADOG_API_KEY_SECRET ? v : null)
  const ctx = { captureContent: false, installId: 'inst-1', appVersion: '2.0.0' }

  it('missing names the api key; createSink returns null without it', () => {
    expect(datadogProvider.missing({}, secret(null))).toBe('api-key')
    expect(datadogProvider.missing({}, secret('k'))).toBeNull()
    expect(datadogProvider.createSink({}, secret(null), ctx)).toBeNull()
  })

  it('blank ml_app falls back to argus; an invalid one throws (health row error)', async () => {
    const sink = datadogProvider.createSink({ mlApp: '  ' }, secret('k'), ctx)
    expect(sink).not.toBeNull()
    await sink!.shutdown()
    expect(() => datadogProvider.createSink({ mlApp: 'Bad App' }, secret('k'), ctx)).toThrow(
      /invalid ML app "Bad App"/
    )
  })

  it('tags every payload with service, version, install id, env and (policy) user', async () => {
    const bodies: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(null, { status: 202 })
    }) as typeof fetch
    try {
      const sink = datadogProvider.createSink(
        { env: 'prod', userLogin: 'octocat', intakeUrl: 'http://127.0.0.1:1' },
        secret('k'),
        ctx
      )!
      sink.emit([ROOT])
      await sink.flush()
      await sink.shutdown()
    } finally {
      globalThis.fetch = realFetch
    }
    const tags = JSON.parse(bodies[0]).data.attributes.tags
    expect(tags).toEqual([
      'service:argus',
      'version:2.0.0',
      'argus.install_id:inst-1',
      'env:prod',
      'argus.user:octocat'
    ])
  })
})
