/**
 * Credential probe for the Langfuse connection health check.
 *
 * `/api/public/health` is unauthenticated — it answers 200 for any reachable
 * Langfuse deployment, including one your keys have no access to, so it cannot
 * tell "configured correctly" from "silently dropping every event". This hits
 * `/api/public/projects` with HTTP Basic (publicKey:secretKey), which is the
 * canonical key-pair check: it 401s with a descriptive message on bad creds or
 * a wrong regional host, and returns the owning project on success.
 *
 * Deliberately fetch-based rather than routed through the `langfuse` SDK: the
 * check must stay meaningful across the v4 migration, and the public REST API
 * is stable where the client surface is not.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface LangfuseCredentials {
  host: string
  publicKey: string
  secretKey: string
}

export async function probeLangfuseCredentials(
  creds: LangfuseCredentials,
  fetchImpl: FetchLike = fetch
): Promise<{ ok: boolean; detail: string }> {
  if (!creds.host) return { ok: false, detail: 'no host configured' }
  if (!creds.publicKey) return { ok: false, detail: 'no public key configured' }
  // Distinct from the above: the key is configured but the encrypted store did
  // not give it back (missing entry, or safeStorage failed to decrypt).
  if (!creds.secretKey) return { ok: false, detail: 'no secret key stored' }

  const auth = Buffer.from(`${creds.publicKey}:${creds.secretKey}`).toString('base64')
  try {
    const res = await fetchImpl(`${creds.host.replace(/\/$/, '')}/api/public/projects`, {
      headers: { Authorization: `Basic ${auth}` }
    })
    if (!res.ok) return { ok: false, detail: await failureDetail(res) }
    const name = await projectName(res)
    return { ok: true, detail: name ? `authenticated · project "${name}"` : 'authenticated' }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

/** Langfuse returns `{message}` on auth failures; fall back to the status code. */
async function failureDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string }
    if (body?.message) return `HTTP ${res.status} · ${body.message}`
  } catch {
    // non-JSON body (proxy/gateway error page) — the status is all we have
  }
  return `HTTP ${res.status}`
}

async function projectName(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { data?: Array<{ name?: string }> }
    return body?.data?.[0]?.name ?? null
  } catch {
    return null
  }
}
