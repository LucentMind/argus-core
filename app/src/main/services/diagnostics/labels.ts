import type { ElectronProcessMetric, ProcessSample } from '../../../shared/diagnostics'
import { tierB } from './labels/electron'
import { tierC } from './labels/command'
import type { LabelSources, ResolvedLabel } from './labels/types'

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
 * consulted in strict precedence — B (Electron metrics, authoritative) then C
 * (command-line inference, `inferred: true`) then null. Tier A (the spawn-site
 * registry) is added in front of B in increment 2b.
 */
export function resolveLabel(
  sample: ProcessSample,
  electron: ElectronProcessMetric | undefined,
  sources: LabelSources
): ResolvedLabel | null {
  if (electron) return tierB(electron, sources.windows)
  return tierC(sample, sources.connectors)
}
