import type { ToolTaxonomy } from '../../risk'

/**
 * Copilot's permission channel raises typed `PermissionRequest` kinds, not bare tool
 * names (EVIDENCE §2/§3). The driver's permission handler synthesizes a canonical tool
 * name + input per kind before consulting the risk classifier:
 *   `write` → 'write' (fs-write), `read` → 'read' (fs-read), `shell` → 'shell' (shell),
 *   `url`   → 'fetch' (network).
 * `mcp`/`custom-tool` map to `mcp__…` names that route through the connector/native
 * branches of `classifyToolCall`, so they need no taxonomy entry here.
 *
 * NO fallback — the Copilot driver declares none, so any unmapped synthesized name
 * (e.g. `copilot:<kind>` for memory/hook/extension requests) fails closed at HIGH ask.
 */
export const COPILOT_TOOL_TAXONOMY: ToolTaxonomy = {
  entries: {
    write: { kind: 'fs-write', pathFields: ['file_path'] },
    read: { kind: 'fs-read', pathFields: ['file_path'] },
    shell: { kind: 'shell', commandField: 'command' },
    fetch: { kind: 'network', urlField: 'url' }
  }
}
