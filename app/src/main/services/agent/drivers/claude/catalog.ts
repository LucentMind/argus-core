import os from 'node:os'
import type { ModelOptionInfo } from '../../../../../shared/runOptions'
import type { CreateQueryFn } from './index'
import { claudeSpawnEnv, resolveClaudeCliPath } from './cliPath'

/**
 * Offline fallback. Deliberately minimal: it exists so the menu degrades rather than
 * disappears when the CLI cannot be reached. The real catalog is version-dependent —
 * the same alias resolves to a different model across CLI versions — so this is a
 * floor, never a source of truth.
 */
const STATIC_FALLBACK: ModelOptionInfo[] = [
  {
    value: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true
  },
  {
    value: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true
  },
  { value: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' }
]

const cache = new Map<string, Promise<ModelOptionInfo[]>>()

// A failed/fallback fetch is cached only briefly: long enough that a cold-start burst
// (several sessions constructed at once) shares a single spawn, short enough that the
// app recovers on its own — no restart, no manual clearCatalogCache() — once the CLI or
// network comes back. A SUCCESSFUL fetch has no such expiry; it stays cached for the
// process lifetime as before.
const FAILURE_TTL_MS = 60000

// Cleanup (the finally block's interrupt()) gets its own short, fixed deadline,
// independent of the caller's (possibly much longer) probe timeoutMs. Without this, a
// real CLI whose control channel never answers makes `ask()` — and therefore anything
// awaiting it, up to CaseSession.stop() — hang indefinitely rather than merely up to
// timeoutMs. A leaked child process is strictly better than an unresolvable stop().
const CLEANUP_TIMEOUT_MS = 2000

export function clearCatalogCache(): void {
  cache.clear()
}

async function ask(
  createQuery: CreateQueryFn,
  cliPath: string | undefined,
  timeoutMs: number
): Promise<ModelOptionInfo[]> {
  let q: ReturnType<CreateQueryFn> | null = null
  try {
    q = createQuery({
      prompt: (async function* () {
        yield {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'ping' }] },
          parent_tool_use_id: null,
          session_id: ''
        }
        await new Promise(() => undefined)
      })(),
      options: {
        // Same containment as probe.ts: without an explicit cwd the CLI inherits the
        // app's — "/" for a Finder-launched packaged build — and its boot-time discovery
        // walks into TCC-protected folders, prompting as Argus.
        cwd: os.tmpdir(),
        maxTurns: 0,
        allowedTools: [],
        env: claudeSpawnEnv(),
        ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {})
      }
    })
    const handle = q as unknown as { supportedModels?: () => Promise<ModelOptionInfo[]> }
    if (typeof handle.supportedModels !== 'function') return STATIC_FALLBACK
    const models = await Promise.race([
      handle.supportedModels(),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))
    ])
    return Array.isArray(models) && models.length > 0 ? models : STATIC_FALLBACK
  } catch {
    // Offline, CLI missing, not logged in — a degraded menu, never a blocked send.
    return STATIC_FALLBACK
  } finally {
    // Bounded the same way the probe race above is: a real interrupt() that never
    // settles (hung control channel) must not extend ask()'s total runtime past a short,
    // fixed deadline. Losing this race leaks the child process — acceptable — rather
    // than leaving every awaiter (including CaseSession.stop()) blocked forever.
    await Promise.race([
      q?.interrupt?.().catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, CLEANUP_TIMEOUT_MS))
    ])
  }
}

/** The model catalog this CLI reports, cached per resolved binary path. A successful
 *  fetch is cached for the process lifetime; a failed/fallback one only for
 *  FAILURE_TTL_MS (see its comment) so the app self-heals without a restart. */
export function fetchCatalog(
  createQuery: CreateQueryFn,
  opts: { cliPath?: string; timeoutMs?: number } = {}
): Promise<ModelOptionInfo[]> {
  // resolveClaudeCliPath is the packaged-build escape used at every other spawn site;
  // bypassing it re-opens the Electron execPath trap, where the SDK spawns a .js CLI
  // that dies silently under Electron main and never under plain node.
  const cliPath = opts.cliPath ?? resolveClaudeCliPath()
  const key = cliPath ?? '<default>'
  const hit = cache.get(key)
  if (hit) return hit
  const raw = ask(createQuery, cliPath ?? undefined, opts.timeoutMs ?? 10000)
  const p: Promise<ModelOptionInfo[]> = raw.then((result) => {
    if (result === STATIC_FALLBACK) {
      // Observable degradation (Finding 2): without this, a user pinned to a model the
      // static fallback doesn't list (e.g. claude-opus-5) silently loses effort/1M/
      // ultracode off the wire — no log, no UI signal. Logged once per actual fetch,
      // never per cache hit, since this callback only runs when `raw` itself settles.
      console.warn(
        `[catalog] model catalog fetch failed for cliPath=${key}; falling back to the static list — model options (effort, 1M context, settings) will be limited until the CLI is reachable again.`
      )
      setTimeout(() => {
        // Only evict if this promise is still the live cache entry — a manual
        // clearCatalogCache() (or, in principle, a re-entrant fetch) may have already
        // replaced or removed it.
        if (cache.get(key) === p) cache.delete(key)
      }, FAILURE_TTL_MS)
    }
    return result
  })
  cache.set(key, p)
  return p
}

/** The catalog entry for one model, matched by alias first then by resolved wire slug
 *  so sessions pinned before the alias change keep resolving. */
export async function catalogFor(
  createQuery: CreateQueryFn,
  cliPath: string | undefined,
  model: string | undefined
): Promise<ModelOptionInfo | null> {
  if (!model) return null
  const bare = model.replace(/\[1m\]$/, '')
  const models = await fetchCatalog(createQuery, cliPath ? { cliPath } : {})
  return (
    models.find((m) => m.value === model || m.value === bare) ??
    models.find(
      (m) => m.resolvedModel === model || m.resolvedModel?.replace(/\[1m\]$/, '') === bare
    ) ??
    null
  )
}
