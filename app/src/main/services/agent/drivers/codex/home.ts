/**
 * Resolve the CODEX_HOME override for the session/probe/headless `codex app-server` runs
 * under. Unlike copilot's `copilotHome(argusHome)`, the default here is to leave CODEX_HOME
 * UNSET: `auth.json` is CODEX_HOME-scoped, and the documented auth flow (design spec §6) is
 * a plain `codex login`, which writes to the global `~/.codex` — the codex binary's own
 * default when CODEX_HOME is absent. Forcing an argusHome-derived default dir would silently
 * break that flow (a never-populated dir always reads as signed-out).
 *
 * A per-instance `config.codexHome` override is opt-in, for multi-account separation (keeps
 * `auth.json` separate per the Codex settings form) — when set (non-empty after trimming), it
 * wins and is returned as-is. Returns `undefined` when there is no override, so callers must
 * only add `CODEX_HOME` to the spawn env when this returns a value.
 */
export function codexHome(override?: string): string | undefined {
  const trimmed = override?.trim()
  return trimmed ? trimmed : undefined
}
