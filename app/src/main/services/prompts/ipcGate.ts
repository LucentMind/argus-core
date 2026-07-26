/**
 * Refuse a dev-prompts IPC call when the dev-tools gate is off.
 *
 * Extracted so every handler shares one message and one behavior, and so the refusal is
 * unit-testable without an Electron IPC harness.
 */
export function assertDevTools(devTools: boolean): void {
  if (!devTools) throw new Error('dev tools are not enabled (set ARGUS_DEV_TOOLS=1)')
}
