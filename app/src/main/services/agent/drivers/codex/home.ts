import path from 'node:path'

/**
 * Resolve the CODEX_HOME the session's `codex app-server` runs under. A per-instance
 * `config.codexHome` override wins when set (keeps `auth.json` separate for multi-account,
 * per the Codex settings form); otherwise a stable dir derived from `argusHome`, mirroring
 * copilot's `copilotHome(argusHome)` = `<argusHome>/copilot-home` convention.
 */
export function codexHome(argusHome: string, override?: string): string {
  const trimmed = override?.trim()
  if (trimmed) return trimmed
  return path.join(argusHome, 'codex-home')
}
