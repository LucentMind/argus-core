/**
 * Which ask-gated tools accept user-edited input on approval (updatedInput).
 * Connector (MCP) tools are editable; Argus's own native tools (`mcp__argus__*`)
 * are read-only as defense in depth — EXCEPT the exact allowlist below, where the
 * args are pure reviewed content and editing is the review mechanism (wave 3 spec
 * §1.2). Never add Bash or tools whose args name commands, paths, or refs.
 */
const EDITABLE_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  'mcp__argus__write_memory',
  'mcp__argus__panel_emit_finding'
])

export function isEditableTool(tool: string): boolean {
  return /^mcp__(?!argus__)/.test(tool) || EDITABLE_NATIVE_TOOLS.has(tool)
}
