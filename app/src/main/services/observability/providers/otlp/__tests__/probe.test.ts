import { createServer } from 'node:http'
import { describe, it, expect } from 'vitest'
import { ExportResultCode } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node'
import { probeOtlp, type ExporterFactory } from '../probe'

const ok = (): SpanExporter => ({
  export: (_s, cb) => cb({ code: ExportResultCode.SUCCESS }),
  shutdown: async () => {},
  forceFlush: async () => {}
})

describe('probeOtlp', () => {
  it('reports ok when the exporter accepts the probe span, with the endpoint in detail', async () => {
    const exported: ReadableSpan[] = []
    const r = await probeOtlp(
      { endpoint: 'http://x:4318', protocol: 'http/json', authorization: null },
      () => ({
        export: (s, cb) => {
          exported.push(...s)
          cb({ code: ExportResultCode.SUCCESS })
        },
        shutdown: async () => {},
        forceFlush: async () => {}
      })
    )
    expect(r).toEqual({ ok: true, detail: 'exported 1 span to http://x:4318/v1/traces' })
    expect(exported.map((s) => s.name)).toEqual(['argus.probe'])
  })

  it('reports the exporter error on failure, and a missing endpoint without exporting', async () => {
    const r = await probeOtlp(
      { endpoint: 'http://x:4318', protocol: 'http/json', authorization: null },
      () => ({
        export: (_s, cb) =>
          cb({ code: ExportResultCode.FAILED, error: new Error('401 Unauthorized') }),
        shutdown: async () => {},
        forceFlush: async () => {}
      })
    )
    expect(r).toEqual({ ok: false, detail: '401 Unauthorized' })
    let called = false
    const none = await probeOtlp(
      { endpoint: '', protocol: 'http/json', authorization: null },
      () => {
        called = true
        throw new Error('must not build')
      }
    )
    expect(none).toEqual({ ok: false, detail: 'no endpoint configured' })
    expect(called).toBe(false)
  })

  it('surfaces a factory throw (bad URL) as not ok instead of rejecting', async () => {
    const r = await probeOtlp(
      { endpoint: 'not a url', protocol: 'http/json', authorization: null },
      () => {
        throw new Error('Invalid URL')
      }
    )
    expect(r).toEqual({ ok: false, detail: 'Invalid URL' })
  })

  it('appends /v1/traces only when the endpoint lacks it, and passes protocol + Authorization + a 5 s timeout to the factory', async () => {
    const seen: Parameters<ExporterFactory>[0][] = []
    const r = await probeOtlp(
      { endpoint: 'http://x:4318/v1/traces', protocol: 'http/protobuf', authorization: 'Bearer t' },
      (c) => {
        seen.push(c)
        return ok()
      }
    )
    expect(r.detail).toBe('exported 1 span to http://x:4318/v1/traces')
    expect(seen).toEqual([
      {
        url: 'http://x:4318/v1/traces',
        protocol: 'http/protobuf',
        headers: { Authorization: 'Bearer t' },
        // Bounded so an unreachable host fails the probe in 5 s, not the 10 s default.
        timeoutMillis: 5000
      }
    ])
  })
})

describe('probeOtlp against a real local receiver (default exporter factory)', () => {
  type Seen = { url?: string; headers: Record<string, string | string[] | undefined>; body: Buffer }
  async function receiver(
    status: number
  ): Promise<{ endpoint: string; seen: Seen[]; close: () => Promise<void> }> {
    const seen: Seen[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
        res.statusCode = status
        res.end(status === 200 ? '{}' : 'Unauthorized')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as { port: number }
    return {
      endpoint: `http://127.0.0.1:${port}`,
      seen,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections()
          server.close(() => r())
        })
    }
  }

  it.each([
    ['http/json', 'application/json'],
    ['http/protobuf', 'application/x-protobuf']
  ] as const)('%s sends Content-Type %s and the Authorization header', async (protocol, ctype) => {
    const rx = await receiver(200)
    try {
      const r = await probeOtlp({ endpoint: rx.endpoint, protocol, authorization: 'Bearer t0k' })
      expect(r).toEqual({ ok: true, detail: `exported 1 span to ${rx.endpoint}/v1/traces` })
      expect(rx.seen).toHaveLength(1)
      expect(rx.seen[0].url).toBe('/v1/traces')
      expect(rx.seen[0].headers['content-type']).toBe(ctype)
      expect(rx.seen[0].headers.authorization).toBe('Bearer t0k')
      expect(rx.seen[0].body.toString('latin1')).toContain('argus.probe')
      if (protocol === 'http/json') {
        expect(() => JSON.parse(rx.seen[0].body.toString())).not.toThrow()
      } else {
        expect(() => JSON.parse(rx.seen[0].body.toString())).toThrow()
      }
    } finally {
      await rx.close()
    }
  })

  it('surfaces a 401 as not ok with the exporter detail', async () => {
    const rx = await receiver(401)
    try {
      const r = await probeOtlp({
        endpoint: rx.endpoint,
        protocol: 'http/json',
        authorization: null
      })
      expect(r.ok).toBe(false)
      expect(r.detail).toMatch(/401|Unauthorized/)
      expect(rx.seen[0].headers.authorization).toBeUndefined()
    } finally {
      await rx.close()
    }
  })
})
