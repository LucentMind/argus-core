import type { ElectronProcessMetric, ProcessSample } from '../../../shared/diagnostics'
import { tierB } from './labels/electron'
import { tierC } from './labels/command'
import type { LabelSources, ResolvedLabel } from './labels/types'
import { identityKey } from './identity'

export type {
  ConnectorCommand,
  LabelSources,
  ResolvedLabel,
  WindowDescriptor
} from './labels/types'
export { argv0Basename, stdioConnectorCommands } from './labels/command'

/**
 * Resolve a raw process sample to an Argus-object label.
 *
 * Pure: every input is a parameter, so no electron import and no I/O. Tiers are
 * consulted in strict precedence — A (the spawn-site registry, authoritative)
 * then B (Electron metrics, authoritative) then C (command-line inference,
 * `inferred: true`) then null.
 */
export function resolveLabel(
  sample: ProcessSample,
  electron: ElectronProcessMetric | undefined,
  sources: LabelSources
): ResolvedLabel | null {
  const registered = sources.registered.get(identityKey(sample.pid, sample.startTimeMs))
  if (registered) return { ...registered, inferred: false }
  if (electron) return tierB(electron, sources.windows)
  return tierC(sample, sources.connectors)
}
