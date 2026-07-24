import { CURSOR_MODELS } from '../../../../../../shared/drivers'
import type { AcpAgentProfile } from './types'

/**
 * Cursor CLI (`cursor-agent`) ACP profile (Task 7). All argv/auth/model values here are
 * PLAN-DERIVED, pending live capture (no `cursor-agent` binary exists in this environment —
 * see the parent plan's Task 1 EVIDENCE.md and `shared/drivers.ts`'s `CURSOR_MODELS` comment,
 * which carries the identical caveat). Do not treat these as verified against the real CLI.
 *
 * `resolveModel` is the base-id alias collapse ported from t3code's
 * `resolveCursorAcpBaseModelId`: Argus's own `composer`/`composer-1` shorthand slugs resolve to
 * the CLI's actual model ids (`composer-2`/`composer-1.5`); anything else (already a base id,
 * or unknown) passes through unchanged.
 */
export const CURSOR_PROFILE: AcpAgentProfile = {
  kind: 'cursor',
  displayName: 'Cursor',
  spawn: ({ cliPath }) => ({
    command: cliPath || 'cursor-agent',
    args: ['acp'],
    env: process.env
  }),
  auth: {
    envVar: 'CURSOR_API_KEY',
    loginHint: 'Run `cursor-agent login` or set CURSOR_API_KEY.'
  },
  models: CURSOR_MODELS,
  resolveModel: (slug) =>
    (({ composer: 'composer-2', 'composer-1': 'composer-1.5' }) as Record<string, string>)[slug] ??
    slug,
  // Cursor's ACP session doesn't take a model at `newSession` time — the driver (index.ts)
  // sends an explicit post-init request via `AcpSessionLike.setModel` instead.
  selectModelAfterStart: true
}
