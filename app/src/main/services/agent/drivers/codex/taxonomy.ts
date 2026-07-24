import type { ToolTaxonomy } from '../../risk'

/**
 * The Codex app-server's approval requests don't carry bare tool names either — they
 * arrive as `item/commandExecution/requestApproval` / `execCommandApproval` (shell) and
 * `item/fileChange/requestApproval` / `applyPatchApproval` (write). `mapping.ts`
 * synthesizes a canonical `{ name, input }` pair per request before consulting the risk
 * classifier, mirroring the Copilot driver's approach (`copilot/taxonomy.ts`).
 *
 * NO fallback — the Codex driver declares none, so any unmapped synthesized name (e.g.
 * `codex:<method>` for an approval method outside the four known ones) fails closed at
 * HIGH ask.
 */
export const CODEX_TOOL_TAXONOMY: ToolTaxonomy = {
  entries: {
    write: { kind: 'fs-write', pathFields: ['file_path'] },
    read: { kind: 'fs-read', pathFields: ['file_path'] },
    shell: { kind: 'shell', commandField: 'command' }
  }
}
