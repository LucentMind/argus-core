import { describe, it, expect } from 'vitest'
import { startOtlpReceiver } from '../otlpReceiver.mjs'

const post = (url, contentType, body) =>
  fetch(`${url}/v1/traces`, { method: 'POST', headers: { 'content-type': contentType }, body })

describe('startOtlpReceiver', () => {
  it('accepts OTLP/JSON traces and flattens spans, attributes and events', async () => {
    const rx = await startOtlpReceiver({ port: 0 })
    try {
      const body = {
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'argus' } }]
            },
            scopeSpans: [
              {
                spans: [
                  {
                    name: 'chat m',
                    traceId: 'ab'.repeat(16),
                    spanId: 'cd'.repeat(8),
                    parentSpanId: 'ef'.repeat(8),
                    attributes: [
                      { key: 'gen_ai.usage.input_tokens', value: { intValue: '10' } },
                      { key: 'argus.cost_usd', value: { doubleValue: 0.5 } },
                      { key: 'argus.flag', value: { boolValue: true } },
                      {
                        key: 'argus.list',
                        value: { arrayValue: { values: [{ stringValue: 'a' }] } }
                      }
                    ],
                    events: [
                      {
                        name: 'gen_ai.evaluation.result',
                        attributes: [
                          { key: 'gen_ai.evaluation.score.value', value: { doubleValue: 1 } }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
      const res = await post(rx.url, 'application/json', JSON.stringify(body))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({})
      const [span] = rx.spans()
      expect(span).toMatchObject({
        name: 'chat m',
        traceId: 'ab'.repeat(16),
        spanId: 'cd'.repeat(8),
        parentSpanId: 'ef'.repeat(8),
        attributes: {
          'gen_ai.usage.input_tokens': 10,
          'argus.cost_usd': 0.5,
          'argus.flag': true,
          'argus.list': JSON.stringify({ values: [{ stringValue: 'a' }] })
        },
        resource: { 'service.name': 'argus' }
      })
      expect(span.events[0]).toMatchObject({
        name: 'gen_ai.evaluation.result',
        attributes: { 'gen_ai.evaluation.score.value': 1 }
      })
      expect(rx.requests()).toBe(1)
      expect(rx.undecoded()).toBe(0)
    } finally {
      await rx.close()
    }
  })

  it('counts a protobuf request it cannot decode instead of hanging, and answers 200', async () => {
    const rx = await startOtlpReceiver({ port: 0 })
    try {
      const res = await post(rx.url, 'application/x-protobuf', new Uint8Array([10, 0]))
      expect(res.status).toBe(200)
      expect(rx.requests()).toBe(1)
      expect(rx.undecoded()).toBe(1)
      expect(rx.spans()).toEqual([])
    } finally {
      await rx.close()
    }
  })
})
