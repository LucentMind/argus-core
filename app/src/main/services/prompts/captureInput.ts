import { NATIVE_TOOL_DRIVERS, resolveToolSpecs } from '../agent/nativeTools'
import {
  panelCommandDescription,
  panelToolName,
  type PanelCommandDecl
} from '../agent/panelCommands'
import type { PromptCaptureFragment, PromptCaptureTool } from '../../../shared/promptsIpc'

/**
 * The pure half of building a `SessionPromptCapture`, kept out of `session.ts` so it is testable
 * without a database, a driver or a case directory.
 */

/** Pair each composed persona fragment with the registry id that produced it. */
export function captureFragments(input: {
  fragments: readonly string[]
  /** Parallel to `fragments`; null where the registry does not own the text. */
  ids: readonly (string | null)[]
  activeOverrides: readonly string[]
}): PromptCaptureFragment[] {
  const overridden = new Set(input.activeOverrides)
  return input.fragments.map((text, i) => {
    // `?? null` rather than an index assumption: a future assembler that appends a fragment
    // without an id must degrade to "unattributed" here, not throw mid session-construction.
    const id = input.ids[i] ?? null
    return {
      id,
      label: id ?? 'Pack or settings fragment',
      chars: text.length,
      overridden: id != null && overridden.has(id)
    }
  })
}

/** Everything advertised to the model as a callable tool, tagged by where it came from. */
export function captureTools(input: {
  driverKind: string
  /** Prompt-registry resolver, so an overridden tool description shows as it was sent. */
  resolve?: (id: string) => string
  panelCommandDecls: readonly PanelCommandDecl[]
  /** Composed connector server ids (`extraMcpServers` keys). */
  connectorIds: readonly string[]
}): PromptCaptureTool[] {
  const native: PromptCaptureTool[] = (NATIVE_TOOL_DRIVERS as readonly string[]).includes(
    input.driverKind
  )
    ? resolveToolSpecs(input.resolve).map((s) => ({
        name: s.name,
        description: s.description,
        origin: 'native' as const
      }))
    : []
  const pack: PromptCaptureTool[] = input.panelCommandDecls.map((d) => ({
    name: panelToolName(d),
    description: panelCommandDescription(d),
    origin: 'pack' as const
  }))
  // Argus composes the SERVER; its tool list is resolved remotely by the driver's SDK and is
  // never visible here. Listing the server honestly beats inventing tool names.
  const connector: PromptCaptureTool[] = input.connectorIds.map((id) => ({
    name: id,
    description: 'Connector MCP server (tool list is remote)',
    origin: 'connector' as const
  }))
  return [...native, ...pack, ...connector]
}
