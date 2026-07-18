/**
 * Latest published version of a CLI package, for the settings update advisory.
 *
 * Advisory only — nothing is ever installed automatically. Every failure mode (offline,
 * 404, malformed body, slow registry) collapses to `null`, which renders as "no update
 * known" rather than an error: a version check failing is not a provider problem, and
 * surfacing it as one would be noise on a page whose job is reporting provider health.
 *
 * Results are cached for an hour so the 5-minute status refresh doesn't hammer the registry.
 */
const TTL_MS = 60 * 60_000

interface Entry {
  version: string | null
  at: number
}

export function createNpmVersionLookup(deps?: {
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}): (pkg: string) => Promise<string | null> {
  const doFetch = deps?.fetch ?? fetch
  const now = deps?.now ?? Date.now
  const timeoutMs = deps?.timeoutMs ?? 5000
  const cache = new Map<string, Entry>()

  return async (pkg: string): Promise<string | null> => {
    const hit = cache.get(pkg)
    if (hit && now() - hit.at < TTL_MS) return hit.version
    let version: string | null = null
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      // The `abbreviated` accept header returns a much smaller document than the full
      // packument — we only need dist-tags.
      const res = await doFetch(`https://registry.npmjs.org/${pkg}/latest`, {
        signal: ac.signal,
        headers: { accept: 'application/vnd.npm.install-v1+json' }
      })
      if (res.ok) {
        const body = (await res.json()) as { version?: unknown }
        if (typeof body.version === 'string') version = body.version
      }
    } catch {
      version = null
    } finally {
      clearTimeout(timer)
    }
    cache.set(pkg, { version, at: now() })
    return version
  }
}
