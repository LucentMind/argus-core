import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

export interface PanelCommandDecl {
  packId: string
  windowId: string
  cmd: string
  risk: 'low' | 'medium' | 'high'
  args: string[]
}

export function flattenPanelCommands(
  windows: Array<{
    packId: string
    decl: {
      id: string
      commands: Array<{ id: string; risk: 'low' | 'medium' | 'high'; args: string[] }>
    }
  }>
): PanelCommandDecl[] {
  return windows.flatMap((w) =>
    w.decl.commands.map((c) => ({
      packId: w.packId,
      windowId: w.decl.id,
      cmd: c.id,
      risk: c.risk,
      args: c.args
    }))
  )
}

export function panelToolName(d: PanelCommandDecl): string {
  return `mcp__${d.packId}__${d.windowId}_${d.cmd}`
}

export function panelCommandRiskMap(
  decls: PanelCommandDecl[]
): Record<string, 'low' | 'medium' | 'high'> {
  return Object.fromEntries(decls.map((d) => [panelToolName(d), d.risk]))
}

const asText = (text: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text }]
})

export interface PanelCommandTool {
  packId: string
  name: string
  handler: (a: Record<string, unknown>) => Promise<{ content: [{ type: 'text'; text: string }] }>
}

/** Pure, directly-testable core: one tool descriptor per declared command. `createSdkMcpServer`
 *  does not expose its built tools' handlers on the returned object (only an internal
 *  `instance._registeredTools`, not a stable/testable surface) — so the handler-construction
 *  logic lives here, behind a plain function, and `buildPanelCommandServers` below just wraps
 *  these into SDK servers. */
export function buildPanelCommandTools(
  decls: PanelCommandDecl[],
  dispatch: (packId: string, windowId: string, cmd: string, args: unknown[]) => Promise<unknown>
): PanelCommandTool[] {
  return decls.map((d) => ({
    packId: d.packId,
    name: `${d.windowId}_${d.cmd}`,
    handler: async (a: Record<string, unknown>) =>
      asText(
        JSON.stringify(
          await dispatch(
            d.packId,
            d.windowId,
            d.cmd,
            d.args.map((n) => a[n])
          ),
          null,
          2
        )
      )
  }))
}

/** One in-process MCP server per pack (name = packId); tools named `<window>_<cmd>` →
 *  agent tool `mcp__<packId>__<window>_<cmd>`. Each handler maps declared arg names to a
 *  positional array and dispatches to the open panel. */
export function buildPanelCommandServers(
  decls: PanelCommandDecl[],
  dispatch: (packId: string, windowId: string, cmd: string, args: unknown[]) => Promise<unknown>
): Record<string, ReturnType<typeof createSdkMcpServer>> {
  const byPack = new Map<string, PanelCommandDecl[]>()
  for (const d of decls) byPack.set(d.packId, [...(byPack.get(d.packId) ?? []), d])
  const toolsByPack = new Map<string, PanelCommandTool[]>()
  for (const t of buildPanelCommandTools(decls, dispatch))
    toolsByPack.set(t.packId, [...(toolsByPack.get(t.packId) ?? []), t])

  const out: Record<string, ReturnType<typeof createSdkMcpServer>> = {}
  for (const [packId, cmds] of byPack) {
    const packTools = toolsByPack.get(packId) ?? []
    out[packId] = createSdkMcpServer({
      name: packId,
      version: '1.0.0',
      tools: cmds.map((d, i) => {
        const t = packTools[i]
        return tool(
          t.name,
          `Run the '${d.cmd}' command of the ${d.packId}/${d.windowId} panel.`,
          Object.fromEntries(d.args.map((a) => [a, z.string()])),
          t.handler
        )
      })
    })
  }
  return out
}
