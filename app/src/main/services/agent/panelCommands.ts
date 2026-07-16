import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

export interface PanelCommandDecl {
  packId: string
  windowId: string
  cmd: string
  risk: 'low' | 'medium' | 'high'
  args: string[]
  /** Author-supplied text (manifest) so the agent knows when/how to call the tool. */
  title?: string
  description?: string
  argDescriptions?: Record<string, string>
}

interface CommandManifest {
  id: string
  risk: 'low' | 'medium' | 'high'
  args: string[]
  title?: string
  description?: string
  argDescriptions?: Record<string, string>
}

export function flattenPanelCommands(
  windows: Array<{ packId: string; decl: { id: string; commands: CommandManifest[] } }>
): PanelCommandDecl[] {
  return windows.flatMap((w) =>
    w.decl.commands.map((c) => ({
      packId: w.packId,
      windowId: w.decl.id,
      cmd: c.id,
      risk: c.risk,
      args: c.args,
      title: c.title,
      description: c.description,
      argDescriptions: c.argDescriptions
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
  /** The MCP tool description the agent sees — manifest description ?? title ?? generic fallback. */
  description: string
  /** Zod input shape (one string per declared arg, with the author's per-arg description if given). */
  argShape: Record<string, z.ZodString>
  handler: (a: Record<string, unknown>) => Promise<{ content: [{ type: 'text'; text: string }] }>
}

/** The tool description the agent sees. Author-supplied `description` (or `title`) wins; the
 *  generic string is only a last resort so an undescribed command is still callable. */
export function panelCommandDescription(d: PanelCommandDecl): string {
  return (
    d.description ?? d.title ?? `Run the '${d.cmd}' command of the ${d.packId}/${d.windowId} panel.`
  )
}

/** Pure, directly-testable core: one tool descriptor per declared command. `createSdkMcpServer`
 *  does not expose its built tools on the returned object (only an internal `_registeredTools`,
 *  not a stable/testable surface) — so the descriptor construction (name, description, input
 *  shape, handler) lives here, behind a plain function, and `buildPanelCommandServers` below just
 *  wraps these into SDK servers. */
export function buildPanelCommandTools(
  decls: PanelCommandDecl[],
  dispatch: (packId: string, windowId: string, cmd: string, args: unknown[]) => Promise<unknown>
): PanelCommandTool[] {
  return decls.map((d) => ({
    packId: d.packId,
    name: `${d.windowId}_${d.cmd}`,
    description: panelCommandDescription(d),
    argShape: Object.fromEntries(
      d.args.map((a) => {
        const desc = d.argDescriptions?.[a]
        return [a, desc ? z.string().describe(desc) : z.string()]
      })
    ),
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
 *  agent tool `mcp__<packId>__<window>_<cmd>`. Description + input shape carry the manifest's
 *  author-supplied text so the agent knows when/how to call each command. */
export function buildPanelCommandServers(
  decls: PanelCommandDecl[],
  dispatch: (packId: string, windowId: string, cmd: string, args: unknown[]) => Promise<unknown>
): Record<string, ReturnType<typeof createSdkMcpServer>> {
  const toolsByPack = new Map<string, PanelCommandTool[]>()
  for (const t of buildPanelCommandTools(decls, dispatch))
    toolsByPack.set(t.packId, [...(toolsByPack.get(t.packId) ?? []), t])

  const out: Record<string, ReturnType<typeof createSdkMcpServer>> = {}
  for (const [packId, packTools] of toolsByPack) {
    out[packId] = createSdkMcpServer({
      name: packId,
      version: '1.0.0',
      tools: packTools.map((t) => tool(t.name, t.description, t.argShape, t.handler))
    })
  }
  return out
}
