import type { ProcessSample } from '../../../../shared/diagnostics'
import {
  connectorConfig,
  type ConnectorMap,
  type StdioConnectorConfig
} from '../../../../shared/connectors'
import type { ConnectorCommand, ResolvedLabel } from './types'

/**
 * The default binary names for each driver. Every driver also exposes a
 * user-configurable `cliPath` (shared/drivers.ts), so an operator who points
 * one at a differently-named binary gets an unlabeled row instead. Reading
 * driver settings to widen this is deliberately not done: 2b's spawn-site
 * registry resolves Codex, Cursor, and Grok authoritatively, and Claude and
 * Copilot are heuristic-only by construction (their SDKs hide the pid).
 */
// A Map, not an object literal: the lookup key is machine-derived (a process
// basename), and a plain object literal is prototype-bearing — a key like
// `constructor` would resolve through Object.prototype instead of missing.
const DRIVER_BASENAMES: Map<string, { provider: string; label: string }> = new Map([
  ['claude', { provider: 'claude-agent-sdk', label: 'Claude driver' }],
  ['copilot', { provider: 'github-copilot', label: 'Copilot driver' }],
  ['codex', { provider: 'codex', label: 'Codex driver' }],
  ['cursor-agent', { provider: 'cursor', label: 'Cursor driver' }],
  ['grok', { provider: 'grok', label: 'Grok driver' }]
])

const PACK_BINARY_BASENAMES = new Set(['graphify'])

/** Electron descendants that getAppMetrics() omits still announce themselves in argv. */
const ELECTRON_TYPE_FLAGS: [string, string][] = [
  ['--type=renderer', 'Renderer process'],
  ['--type=gpu-process', 'GPU process'],
  ['--type=utility', 'Utility process']
]

/**
 * Executable basename of a command line, lowercased and without `.exe`.
 *
 * Takes the leading quoted span when the command starts with a quote,
 * otherwise the first whitespace-delimited token. sysinfo hands TypeScript
 * already-parsed, unquoted argv, so an UNQUOTED path containing spaces still
 * yields the wrong basename — the quoted-span branch above can't help,
 * because the quoting it looks for is already gone by the time we see it.
 * That case now falls through to tierC's `name`-based fallback (see
 * driverOrPackBinaryLabel's callers) rather than silently mislabeling.
 */
export function argv0Basename(command: string): string {
  const trimmed = command.trim()

  // Check if the command starts with a quote and extract the quoted string
  let first: string
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]
    const closeIdx = trimmed.indexOf(quote, 1)
    if (closeIdx !== -1) {
      first = trimmed.substring(0, closeIdx + 1)
    } else {
      first = trimmed.split(/\s+/)[0] ?? ''
    }
  } else {
    first = trimmed.split(/\s+/)[0] ?? ''
  }

  const unquoted = first.replace(/^["']+|["']+$/g, '')
  return normalizeBasename(unquoted)
}

/** Lowercase, extension-stripped basename shared by both the argv0 and `name` keys. */
function normalizeBasename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

/**
 * Tokens too common to identify anything. Without this guard a connector
 * configured as bare `npx -y` would claim every Node process on the machine.
 */
const GENERIC_TOKENS = new Set(['npx', 'node', 'npm', 'uvx', '-y', '--yes'])

function isDistinctive(token: string): boolean {
  return token.length >= 3 && !GENERIC_TOKENS.has(token.toLowerCase())
}

/**
 * Which configured connector, if any, this command line is running.
 *
 * The match cannot key on argv0: a connector configured as
 * `npx -y @scope/server` is spawned on Windows as `node …\npx-cli.js …`, so the
 * basename is `node.exe`. Instead EVERY configured token must appear somewhere
 * in the command line, and at least one of them must be distinctive.
 *
 * Ties resolve by distinctive-token count then by instanceId, so a process
 * never flickers between two labels on consecutive ticks.
 */
function matchConnector(
  command: string,
  connectors: readonly ConnectorCommand[]
): ConnectorCommand | null {
  const haystack = command.toLowerCase()
  let best: { connector: ConnectorCommand; score: number } | null = null

  for (const c of connectors) {
    const tokens = [c.command, ...c.args].filter((t) => t.trim() !== '')
    if (tokens.length === 0) continue
    if (!tokens.every((t) => haystack.includes(t.toLowerCase()))) continue
    const score = tokens.filter(isDistinctive).length
    if (score === 0) continue
    if (
      !best ||
      score > best.score ||
      (score === best.score && c.instanceId < best.connector.instanceId)
    )
      best = { connector: c, score }
  }

  return best ? best.connector : null
}

/**
 * Flatten the live connector map into the shape the matcher wants. HTTP
 * connectors have no local process, so they are dropped.
 *
 * `ConnectorInstance.enabled` is deliberately NOT filtered here: disabling a
 * connector in Settings does not kill an already-running child process, and
 * naming that lingering process by its still-configured command is more
 * useful than dumping it into Unattributed. The false-positive surface this
 * opens is bounded by matchConnector's distinctiveness guard.
 */
export function stdioConnectorCommands(map: ConnectorMap): ConnectorCommand[] {
  const out: ConnectorCommand[] = []
  for (const [instanceId, inst] of Object.entries(map)) {
    if (inst.kind !== 'stdio') continue
    const cfg = connectorConfig<StdioConnectorConfig>('stdio', inst.config)
    if (cfg.command.trim() === '') continue
    out.push({ instanceId, command: cfg.command, args: cfg.args })
  }
  return out
}

/**
 * Driver or pack-binary label for a single candidate basename, or null if
 * neither table recognizes it.
 */
function driverOrPackBinaryLabel(base: string): ResolvedLabel | null {
  const driver = DRIVER_BASENAMES.get(base)
  if (driver)
    return {
      kind: 'driver',
      label: driver.label,
      provider: driver.provider,
      inferred: true
    }

  if (PACK_BINARY_BASENAMES.has(base)) return { kind: 'pack-binary', label: base, inferred: true }

  return null
}

export function tierC(
  sample: ProcessSample,
  connectors: readonly ConnectorCommand[]
): ResolvedLabel | null {
  const argv0Base = argv0Basename(sample.command)

  // sysinfo hands TypeScript already-parsed, unquoted argv, so an UNQUOTED
  // path containing a space (e.g. `C:\Users\John Smith\bin\claude.exe`) splits
  // on the space and argv0Basename yields the wrong token — the quoting that
  // would have protected it is already gone by the time we see it. `name` is
  // the OS-reported process name and isn't split on whitespace, so it survives
  // that case; try it only when the argv0-derived basename found nothing, so
  // argv0 still wins whenever it successfully matches something. This stays a
  // fallback rather than a replacement because on Linux `name` (`comm`) is
  // truncated to 15 characters and is not universally sufficient on its own.
  const byArgv0 = driverOrPackBinaryLabel(argv0Base)
  if (byArgv0) return byArgv0

  const nameBase = normalizeBasename(sample.name)
  if (nameBase !== argv0Base) {
    const byName = driverOrPackBinaryLabel(nameBase)
    if (byName) return byName
  }

  const connector = matchConnector(sample.command, connectors)
  if (connector)
    return {
      kind: 'mcp',
      label: `MCP: ${connector.instanceId}`,
      instanceId: connector.instanceId,
      inferred: true
    }

  for (const [flag, label] of ELECTRON_TYPE_FLAGS)
    if (sample.command.includes(flag)) return { kind: 'electron-internal', label, inferred: true }

  return null
}
