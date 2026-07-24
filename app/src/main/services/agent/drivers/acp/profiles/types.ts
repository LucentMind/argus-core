import type { CatalogModel } from '../../../../../../shared/drivers'
import type { DriverKind } from '../../../driver'

/**
 * Per-agent configuration `createAcpDriver` closes over. One profile == one ACP-speaking CLI
 * (Cursor's `cursor-agent`, xAI's `grok`); Tasks 8/9 each supply a concrete profile, Task 6
 * consumes only this shape.
 */
export interface AcpAgentProfile {
  kind: Extract<DriverKind, 'cursor' | 'grok'>
  displayName: string
  /** Resolve the child-process launch parameters. `env` is `NodeJS.ProcessEnv` (values may be
   *  `undefined`) — the driver filters those out before handing it to `AcpSpawnOpts.env`
   *  (`Record<string,string>`), rather than the profile doing so itself. */
  spawn: (cfg: { cliPath?: string }) => { command: string; args: string[]; env: NodeJS.ProcessEnv }
  auth: { envVar?: string; loginHint: string }
  models: readonly CatalogModel[]
  /** Translate Argus's model slug into whatever the CLI expects; identity when absent. */
  resolveModel?: (slug: string) => string
  /** True when the CLI needs an explicit `session/set_model` request after session creation
   *  rather than accepting a model at `newSession` time. */
  selectModelAfterStart?: boolean
  updateCommand?: string
  npmPackage?: string
}
