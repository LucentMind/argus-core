// A local OTLP/HTTP trace receiver for the credential-free observability gate
// (cdp-observability-otlp.mjs). Plain Node ESM, no dependencies.
//
// Decodes OTLP/JSON (`Content-Type: application/json`, the `http/json` protocol the gate forces):
// `resourceSpans[].scopeSpans[].spans[]` flattened into one list, each OTLP `KeyValue[]` turned
// into a plain object. Any other body — `application/x-protobuf` from a mis-set protocol, or JSON
// that does not parse — is still answered 200 and COUNTED (`requests()` and `undecoded()`), never
// decoded, so a wrong wire format shows up as "requests arrived but no spans decoded" instead of
// an exporter retrying into a hang. Only `POST /v1/traces` is decoded and answered `200 {}` (an
// empty ExportTraceServiceResponse: no partial success); a POST to any other path is answered 404
// and counted in `wrongPath()`, so a regression in the exporter's URL (a dropped or doubled
// `/v1/traces`) fails the gate instead of being silently accepted.
import http from 'node:http'
import zlib from 'node:zlib'

/** OTLP AnyValue → a plain JS value. `intValue` arrives as a string or a number (int64 in JSON);
 *  arrays and kvlists are JSON-encoded, matching what the Argus sink does for non-primitives. */
export function attrValue(v) {
  if (!v || typeof v !== 'object') return undefined
  if ('stringValue' in v) return v.stringValue
  if ('intValue' in v) return Number(v.intValue)
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('boolValue' in v) return Boolean(v.boolValue)
  if ('arrayValue' in v) return JSON.stringify(v.arrayValue)
  if ('kvlistValue' in v) return JSON.stringify(v.kvlistValue)
  if ('bytesValue' in v) return v.bytesValue
  return undefined
}

/** OTLP `KeyValue[]` → `{ key: value }`. */
export function attrsOf(list) {
  const out = {}
  for (const kv of list ?? []) out[kv.key] = attrValue(kv.value)
  return out
}

/** Flatten one ExportTraceServiceRequest (OTLP/JSON) into the receiver's span records. */
export function flattenTraces(body) {
  const out = []
  for (const rs of body?.resourceSpans ?? []) {
    const resource = attrsOf(rs.resource?.attributes)
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        out.push({
          name: s.name,
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId ?? '',
          scope: ss.scope?.name ?? null,
          attributes: attrsOf(s.attributes),
          events: (s.events ?? []).map((e) => ({
            name: e.name,
            attributes: attrsOf(e.attributes)
          })),
          resource
        })
      }
    }
  }
  return out
}

/**
 * Start the receiver on 127.0.0.1:`port` (0 = any free port). Resolves once listening.
 * `url` is the endpoint base (the app appends `/v1/traces`); `spans()` every decoded span so
 * far, `requests()` every POST received, `undecoded()` the requests that carried no decodable
 * OTLP/JSON, `wrongPath()` the POSTs to a path other than /v1/traces (answered 404, not
 * decoded; `lastWrongPath()` is the latest offending path), `close()` stops it.
 */
export function startOtlpReceiver({ port = 0 } = {}) {
  const spans = []
  let requests = 0
  let undecoded = 0
  let wrongPath = 0
  let lastWrongPath = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'POST' && (req.url ?? '').split('?')[0] !== '/v1/traces') {
        wrongPath++
        lastWrongPath = req.url ?? ''
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      if (req.method === 'POST') {
        requests++
        let raw = Buffer.concat(chunks)
        const type = String(req.headers['content-type'] ?? '')
        try {
          if (/gzip/i.test(String(req.headers['content-encoding'] ?? '')))
            raw = zlib.gunzipSync(raw)
          if (!/application\/json/i.test(type)) throw new Error(`not decoded: ${type}`)
          spans.push(...flattenTraces(JSON.parse(raw.toString('utf8'))))
        } catch {
          undecoded++
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        url: `http://127.0.0.1:${actual}`,
        spans: () => [...spans],
        requests: () => requests,
        undecoded: () => undecoded,
        wrongPath: () => wrongPath,
        lastWrongPath: () => lastWrongPath,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          })
      })
    })
  })
}
