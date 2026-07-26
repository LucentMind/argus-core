/**
 * GUARD 2 of the override safety story (spec, "Override safety"), extracted so it is
 * unit-testable without booting the app.
 *
 * A terminal-only session — run the app, reproduce something, read stdout — never opens
 * Settings, so the banner (guard 3) cannot reach it. This is the only guard that does. Pulling
 * the message text out of `registerIpc()` means a future refactor that deletes the `console.warn`
 * calls in `main/index.ts` breaks a test, rather than silently losing the only evidence of an
 * active override in a headless run.
 *
 * The returned strings are logged verbatim by the caller (`console.warn` per entry) — this
 * function does no logging itself, so it stays a pure function of the store's state.
 */
export function overrideBootWarnings(input: { ids: string[]; loadError: string | null }): string[] {
  const out: string[] = []
  if (input.ids.length > 0)
    out.push(
      `[prompts] ${input.ids.length} prompt override(s) ACTIVE — the agent is not running on built-in prompts: ${input.ids.join(', ')}`
    )
  if (input.loadError)
    out.push(`[prompts] override file could not be parsed, using defaults: ${input.loadError}`)
  return out
}
