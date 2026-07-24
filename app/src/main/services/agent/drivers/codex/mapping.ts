import type { ToolDecision } from '../../driver'

export type CodexApprovalGen = 'current' | 'legacy'

const CURRENT_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval'
])
const LEGACY_METHODS = new Set(['execCommandApproval', 'applyPatchApproval'])

/** Which protocol generation an approval-request method belongs to, or null if the
 *  method isn't one of the four known approval methods (current or legacy). */
export function codexApprovalGen(method: string): CodexApprovalGen | null {
  if (CURRENT_METHODS.has(method)) return 'current'
  if (LEGACY_METHODS.has(method)) return 'legacy'
  return null
}

/** Best-effort file path extraction for a fileChange approval, defensive against both
 *  protocol generations:
 *  - legacy `applyPatchApproval`: `params.fileChanges` is a map keyed by file path.
 *  - current `item/fileChange/requestApproval`: carries no patch inline; Task 6's
 *    session may enrich the params with `changes: [{ path }, ...]` once the correlated
 *    `item/fileChange/patchUpdated` notification has arrived.
 *  Returns undefined if neither is present — classification still fails safe on an
 *  undefined path (resolves against caseDir, which is in-sandbox by construction). */
function extractFilePath(params: Record<string, unknown>): string | undefined {
  const fileChanges = params.fileChanges
  if (fileChanges && typeof fileChanges === 'object') {
    const keys = Object.keys(fileChanges as Record<string, unknown>)
    if (keys.length > 0) return keys[0]
  }
  const changes = params.changes
  if (Array.isArray(changes) && changes.length > 0) {
    const first = changes[0]
    if (
      first &&
      typeof first === 'object' &&
      typeof (first as { path?: unknown }).path === 'string'
    ) {
      return (first as { path: string }).path
    }
  }
  return undefined
}

/** Turn a Codex approval-request method + params into a canonical Argus tool call
 *  `{ name, input }` for risk classification. Any method outside the four known
 *  approval methods synthesizes a `codex:<method>` name with no taxonomy entry, which
 *  fails closed to HIGH ask in `classifyToolCall` (no fallback declared in
 *  `CODEX_TOOL_TAXONOMY`). */
export function synthesizeCodexApproval(
  method: string,
  params: Record<string, unknown> = {}
): { name: string; input: Record<string, unknown> } {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const raw = params.command
    const command = Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')
    return { name: 'shell', input: { ...params, command } }
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return { name: 'write', input: { ...params, file_path: extractFilePath(params) } }
  }
  return { name: `codex:${method}`, input: { ...params } }
}

const CURRENT_DECISION: Record<ToolDecision['behavior'], string> = {
  allow: 'accept',
  deny: 'decline'
}
const LEGACY_DECISION: Record<ToolDecision['behavior'], string> = {
  allow: 'approved',
  deny: 'denied'
}

/** Turn an Argus `ToolDecision` back into a Codex decision reply payload, in the
 *  vocabulary matching the generation of the approval request it answers.
 *  `ToolDecision` currently has only `allow`/`deny` behaviors (no allow-for-session or
 *  abort/cancel variant) — both are covered here; if a new behavior is ever added this
 *  object literal will fail to type-check against `Record<ToolDecision['behavior'], …>`,
 *  forcing this mapping to be updated too. */
export function mapCodexDecision(
  d: ToolDecision,
  gen: CodexApprovalGen = 'current'
): { decision: string } {
  const table = gen === 'legacy' ? LEGACY_DECISION : CURRENT_DECISION
  return { decision: table[d.behavior] }
}
