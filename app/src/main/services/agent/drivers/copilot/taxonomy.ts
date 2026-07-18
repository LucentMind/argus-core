import type { ToolTaxonomy } from '../../risk'

/**
 * Task 9A STUB. Copilot's real built-in tool inventory (create/edit/view/glob/grep/
 * powershell/web_fetch/…) and its risk mapping land in Task 9B, which also decides the
 * fallback policy. Until then the taxonomy is intentionally empty with NO fallback, so
 * `classifyToolCall` fails closed (HIGH ask) on any unmapped Copilot tool name.
 */
export const COPILOT_TOOL_TAXONOMY: ToolTaxonomy = {
  entries: {}
}
