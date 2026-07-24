import { GROK_MODELS } from '../../../../../../shared/drivers'
import type { AcpAgentProfile } from './types'

/**
 * Grok (xAI) ACP profile (Task 8). All argv/auth/model values here are PLAN-DERIVED,
 * pending live capture (no `grok` binary exists in this environment — see the parent plan's
 * Task 1 EVIDENCE.md and `shared/drivers.ts`'s `GROK_MODELS` comment, which carries the
 * identical caveat). Do not treat these as verified against the real CLI.
 *
 * Unlike Cursor, Grok has no `resolveModel` hook (no alias collapse needed) and takes
 * a model at `newSession` time directly (no `selectModelAfterStart`).
 */
export const GROK_PROFILE: AcpAgentProfile = {
  kind: 'grok',
  displayName: 'Grok',
  spawn: ({ cliPath }) => ({
    command: cliPath || 'grok',
    args: ['agent', 'stdio'],
    env: process.env
  }),
  auth: {
    envVar: 'XAI_API_KEY',
    loginHint: 'Set XAI_API_KEY (xAI API key).'
  },
  models: GROK_MODELS
}
