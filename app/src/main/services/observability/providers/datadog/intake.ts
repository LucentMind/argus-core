/**
 * The HTTP seam of the Datadog adapter: the two LLM Observability intake endpoints, nothing
 * else. Fetch-based and injectable (`FetchLike`, like `langfuse/probe.ts`) so the sink and the
 * gate never need a real Datadog.
 *
 * Endpoints (docs.datadoghq.com/llm_observability/instrument/api/):
 *   POST <base>/api/intake/llm-obs/v1/trace/spans   202 on success
 *   POST <base>/api/intake/llm-obs/v2/eval-metric   202 on success
 * `<base>` is `https://api.<site>` by default; an org policy can point it at a relay instead.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export const SPANS_PATH = '/api/intake/llm-obs/v1/trace/spans'
export const EVALS_PATH = '/api/intake/llm-obs/v2/eval-metric'
export const VALIDATE_PATH = '/api/v1/validate'

/** Bounds one POST: an unreachable intake must not hold a flush (or app quit) for long. */
const POST_TIMEOUT_MS = 10_000

export interface DatadogIntake {
  postSpans(body: unknown): Promise<void>
  postEvals(body: unknown): Promise<void>
}

/** `https://api.<site>`, or the override with any trailing slash removed. */
export function intakeBase(site: string, intakeUrl?: string | null): string {
  return intakeUrl ? intakeUrl.replace(/\/+$/, '') : `https://api.${site}`
}

/**
 * Datadog error bodies are `{ errors: [string | { detail?, title? }] }`; some proxies answer with
 * `{ message }` or plain text. The status line plus the first message, never the whole body.
 */
export async function failureDetail(res: Response): Promise<string> {
  let first: string | null = null
  try {
    const text = await res.text()
    try {
      const body = JSON.parse(text) as {
        errors?: Array<string | { detail?: string; title?: string }>
        message?: string
      }
      const e = body?.errors?.[0]
      first = typeof e === 'string' ? e : (e?.detail ?? e?.title ?? body?.message ?? null) || null
    } catch {
      first = text.trim().split('\n')[0]?.slice(0, 200) || null
    }
  } catch {
    // unreadable body: the status is all there is
  }
  return first ? `HTTP ${res.status} · ${first}` : `HTTP ${res.status}`
}

export function createDatadogIntake(cfg: {
  base: string
  apiKey: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}): DatadogIntake {
  const doFetch = cfg.fetchImpl ?? fetch
  const post = async (path: string, body: unknown): Promise<void> => {
    const res = await doFetch(`${cfg.base}${path}`, {
      method: 'POST',
      headers: { 'DD-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? POST_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(await failureDetail(res))
    // Drain so the connection is reusable; the body is empty (spans) or an echo (evals).
    await res.arrayBuffer().catch(() => undefined)
  }
  return {
    postSpans: (body) => post(SPANS_PATH, body),
    postEvals: (body) => post(EVALS_PATH, body)
  }
}
