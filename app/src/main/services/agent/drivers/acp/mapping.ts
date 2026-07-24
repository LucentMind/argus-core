export interface SynthesizedAcpRequest { name: string; input: Record<string, unknown> }

export function synthesizeAcpPermission(
  kind: string,
  args: Record<string, unknown> = {}
): SynthesizedAcpRequest {
  switch (kind) {
    case 'execute': return { name: 'shell', input: { command: args.command ?? args.fullCommandText, ...args } }
    case 'read':    return { name: 'read',  input: { file_path: args.path ?? args.file_path } }
    case 'edit':
    case 'delete':
    case 'move':    return { name: 'write', input: { file_path: args.path ?? args.file_path } }
    case 'fetch':   return { name: 'fetch', input: { url: args.url } }
    default:        return { name: `acp:${kind}`, input: { ...args } } // no taxonomy entry → HIGH ask
  }
}

export type AcpToolLifecycleKind = 'command_execution' | 'file_change' | 'web_search' | 'dynamic_tool_call'
export function acpToolCallKind(kind: string | undefined): AcpToolLifecycleKind {
  switch (kind) {
    case 'execute': return 'command_execution'
    case 'edit': case 'delete': case 'move': return 'file_change'
    case 'search': case 'fetch': return 'web_search'
    default: return 'dynamic_tool_call'
  }
}
