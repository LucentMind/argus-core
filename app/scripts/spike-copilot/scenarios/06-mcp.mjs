// Scenario 6: external stdio MCP server attach.
// Points the session at the local mcp-echo-server.mjs and captures the config
// shape sent plus the runtime's load/status events (session.mcp_servers_loaded,
// session.mcp_server_status_changed, mcp.tools.list_changed) and — if quota
// permits — an mcp permission request + tool call.
import path from 'node:path'
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded, HERE } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('06-mcp')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const serverPath = path.join(HERE, 'mcp-echo-server.mjs')
    const mcpServers = {
      argusEcho: { type: 'stdio', command: process.execPath, args: [serverPath] }
    }
    rec('meta', { configSent: { mcpServers } })
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      mcpServers,
      onPermissionRequest: sandboxGuard(rec, (request) => {
        if (request?.kind === 'mcp' && request.serverName === 'argusEcho') return { kind: 'approve-once' }
        return { kind: 'reject', feedback: 'only argusEcho mcp approved' }
      })
    })
    rec('meta', { sessionId: session.sessionId, capabilities: session.capabilities })
    wireAllEvents(session, rec)
    const final = await session.sendAndWait(
      "Use the mcp_echo tool from the argusEcho server with message 'ping' and report exactly what it returned.",
      120000
    )
    rec('result', { finalContent: final?.data?.content })
    await session.disconnect()
  })
  await stop(client)
}
