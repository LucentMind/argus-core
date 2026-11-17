import { VALIDATE_PATH, failureDetail, type FetchLike } from './intake'

/** Bounds the probe on an unreachable host. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Credential probe for the Datadog health row: `GET <base>/api/v1/validate` with `DD-API-KEY`.
 * It answers `{ valid: true }` for a key that belongs to that site's org and 403 otherwise, so it
 * catches a bad key AND the wrong site without writing a junk span into LLM Observability.
 * A relay base (org policy `intakeUrl`) is expected to forward this path too.
 */
export async function probeDatadog(
  cfg: { base: string; site: string; apiKey: string },
  fetchImpl: FetchLike = fetch
): Promise<{ ok: boolean; detail: string }> {
  if (!cfg.apiKey) return { ok: false, detail: 'no API key stored' }
  try {
    const res = await fetchImpl(`${cfg.base}${VALIDATE_PATH}`, {
      headers: { 'DD-API-KEY': cfg.apiKey },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!res.ok) return { ok: false, detail: await failureDetail(res) }
    const body = (await res.json().catch(() => null)) as { valid?: boolean } | null
    if (body?.valid === false) return { ok: false, detail: `API key not valid for ${cfg.site}` }
    return { ok: true, detail: `authenticated · ${cfg.site}` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
