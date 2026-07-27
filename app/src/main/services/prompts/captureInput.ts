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

/** Driver kinds whose driver consumes `ctx.panelCommandDecls` and actually registers pack
 *  panel-commands as MCP tools — `drivers/claude/index.ts:157` (`buildPanelCommandServers`) and
 *  `drivers/copilot/index.ts:201`. Codex has no pack-command wiring; the ACP drivers never read
 *  `panelCommandDecls` either. Independently justified from `NATIVE_TOOL_DRIVERS` even though the
 *  two lists coincide today — a driver could gain one reach without the other. */
const PACK_TOOL_DRIVERS = ['claude-agent-sdk', 'github-copilot'] as const

/** Driver kinds that actually forward `ctx.extraMcpServers` to the model as connector tools.
 *  `drivers/codex/index.ts` has no MCP wiring at all, so codex never sees them. The ACP drivers
 *  (`drivers/acp/index.ts`) call `toAcpMcpServers` but drop the result — they declare
 *  `capabilities.mcpConnectors: false` and emit one `session.mcp.skipped` event per server
 *  instead, so nothing reaches the model there either. Independently justified from
 *  `NATIVE_TOOL_DRIVERS` even though the two lists coincide today — a driver could gain
 *  connector support without gaining native-tool support. */
const CONNECTOR_TOOL_DRIVERS = ['claude-agent-sdk', 'github-copilot'] as const

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
      // Trimmed, not raw, length: composePersona trims each fragment before joining, so raw
      // text.length would over-report a fragment with surrounding whitespace. A whitespace-only
      // fragment correctly reports 0 — it contributed nothing to systemAppend.
      chars: text.trim().length,
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
  const pack: PromptCaptureTool[] = (PACK_TOOL_DRIVERS as readonly string[]).includes(
    input.driverKind
  )
    ? input.panelCommandDecls.map((d) => ({
        name: panelToolName(d),
        description: panelCommandDescription(d),
        origin: 'pack' as const
      }))
    : []
  // Argus composes the SERVER; its tool list is resolved remotely by the driver's SDK and is
  // never visible here. Listing the server honestly beats inventing tool names.
  const connector: PromptCaptureTool[] = (CONNECTOR_TOOL_DRIVERS as readonly string[]).includes(
    input.driverKind
  )
    ? input.connectorIds.map((id) => ({
        name: id,
        description: 'Connector MCP server (tool list is remote)',
        origin: 'connector' as const
      }))
    : []
  return [...native, ...pack, ...connector]
}
