// A local fake of Datadog's LLM Observability intake for the credential-free gate
// (cdp-observability-datadog.mjs). Plain Node ESM, no dependencies.
//
// Answers exactly the three paths the Argus Datadog adapter uses, the way Datadog does:
//   POST /api/intake/llm-obs/v1/trace/spans  → 202, body kept in `spanBodies()`
//   POST /api/intake/llm-obs/v2/eval-metric  → 202, body kept in `evalBodies()`
//   GET  /api/v1/validate                    → 200 {"valid":true} (403 for a key not in `keys`)
// Every request must carry `DD-API-KEY`; a request whose key is not in `keys` gets 403 and is
// counted in `forbidden()`, so a gate can prove which key the app sent (rotation). Anything else
// is a 404 counted in `wrongPath()`. `keysSeen()` lists every key presented, in order.
import http from 'node:http'

export const SPANS_PATH = '/api/intake/llm-obs/v1/trace/spans'
export const EVALS_PATH = '/api/intake/llm-obs/v2/eval-metric'
export const VALIDATE_PATH = '/api/v1/validate'

export function startDatadogReceiver({ port = 0, keys = [] } = {}) {
  const spanBodies = []
  const evalBodies = []
  const keysSeen = []
  const allowed = new Set(keys)
  let requests = 0
  let undecoded = 0
  let forbidden = 0
  let wrongPath = 0
  let lastWrongPath = null
  let validates = 0
  let duplicates = 0
  let zeroDuration = 0
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      requests++
      const url = (req.url ?? '').split('?')[0]
      const key = String(req.headers['dd-api-key'] ?? '')
      keysSeen.push(key)
      const known =
        (req.method === 'POST' && (url === SPANS_PATH || url === EVALS_PATH)) ||
        (req.method === 'GET' && url === VALIDATE_PATH)
      if (!known) {
        wrongPath++
        lastWrongPath = `${req.method} ${req.url}`
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"errors":["Not found"]}')
        return
      }
      if (!allowed.has(key)) {
        forbidden++
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end('{"errors":["Forbidden"]}')
        return
      }
      if (url === VALIDATE_PATH) {
        validates++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"valid":true}')
        return
      }
      try {
        if (!/application\/json/i.test(String(req.headers['content-type'] ?? '')))
          throw new Error('not json')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // Like the real intake: duration must be greater than zero (a bad span rejects the
        // whole request), and two evaluations with the same trace, span, label and timestamp
        // make the whole request a 400 (both seen live 2026-11-17).
        if (url === SPANS_PATH) {
          const spans = body?.data?.attributes?.spans ?? []
          if (spans.some((x) => !(x.duration > 0))) {
            zeroDuration++
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(
              '{"errors":[{"title":"Bad Request","detail":"invalid span: span duration has to be greater than zero"}]}'
            )
            return
          }
        }
        if (url === EVALS_PATH) {
          const seen = new Set()
          for (const m of body?.data?.attributes?.metrics ?? []) {
            const k = [
              m.join_on?.span?.trace_id,
              m.join_on?.span?.span_id,
              m.label,
              m.timestamp_ms
            ].join('|')
            if (seen.has(k)) {
              duplicates++
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end('{"errors":["evaluation metric is a duplicate"]}')
              return
            }
            seen.add(k)
          }
        }
        ;(url === SPANS_PATH ? spanBodies : evalBodies).push(body)
      } catch {
        undecoded++
      }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(url === SPANS_PATH ? '' : '{"data":{}}')
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        url: `http://127.0.0.1:${actual}`,
        allowKey: (k) => allowed.add(k),
        revokeKey: (k) => allowed.delete(k),
        spanBodies: () => [...spanBodies],
        evalBodies: () => [...evalBodies],
        spans: () => spanBodies.flatMap((b) => b?.data?.attributes?.spans ?? []),
        evals: () => evalBodies.flatMap((b) => b?.data?.attributes?.metrics ?? []),
        requests: () => requests,
        undecoded: () => undecoded,
        forbidden: () => forbidden,
        validates: () => validates,
        duplicates: () => duplicates,
        zeroDuration: () => zeroDuration,
        keysSeen: () => [...keysSeen],
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
