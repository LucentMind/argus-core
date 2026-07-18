// Scenario 17: does `resumeSession` honor `mcpServers`? Upstream sdk#1113 (open,
// Jul 2026) reports resume silently drops them — which would matter to Argus,
// since sessions resume across app restarts. Phase 1: createSession with the
// working stdio+tools:["*"] config (scenario 16A), prove the tool call works.
// Phase 2: disconnect, resumeSession with the SAME mcpServers config, ask again.
// Verdict is read from phase 2's mcp_servers_loaded + tool reachability.
import path from 'node:path'
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded, HERE } from '../lib.mjs'

const STDIO_SERVER = path.join(HERE, 'mcp-echo-server.mjs')
const PROMPT =
  "Call the mcp_echo tool from the 'argusEcho' MCP server with message 'ping' and report " +
  'exactly what it returned. If you have no such tool, say exactly: NO_MCP_TOOL.'

function summarize(rec, phase, events, finalText) {
  const loaded = events
    .filter((e) => e?.type === 'session.mcp_servers_loaded')
    .flatMap((e) => e?.data?.servers ?? [])
  const echoed = /mcp-echo:ping/i.test(finalText ?? '')
  const declaredNoTool = /NO_MCP_TOOL/i.test(finalText ?? '')
  rec('result', {
    phase,
    mcpServersLoaded: loaded,
    finalText,
    toolReachable: echoed && !declaredNoTool
  })
}

export default async function run() {
  const { rec } = recorder('17-mcp-resume')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const mcpServers = {
      argusEcho: { type: 'stdio', command: process.execPath, args: [STDIO_SERVER], tools: ['*'] }
    }
    const config = () => ({
      workingDirectory: sandboxDir(),
      streaming: true,
      mcpServers,
      onPermissionRequest: sandboxGuard(rec, (request) => {
        if (request?.kind === 'mcp' && request.serverName === 'argusEcho') return { kind: 'approve-once' }
        return { kind: 'reject', feedback: 'only argusEcho mcp approved' }
      })
    })

    // Phase 1: fresh session — expected connected + reachable (16A).
    const events1 = []
    const s1 = await client.createSession(config())
    const sessionId = s1.sessionId
    rec('meta', { phase: 'create', sessionId, configSent: { mcpServers } })
    s1.on((e) => events1.push(e))
    wireAllEvents(s1, rec)
    const final1 = await s1.sendAndWait(PROMPT, 120000)
    const text1 = Array.isArray(final1?.data?.content)
      ? final1.data.content.map((c) => c?.text ?? '').join('')
      : String(final1?.data?.content ?? '')
    summarize(rec, 'create', events1, text1)
    await s1.disconnect()

    // Phase 2: resume the SAME session id with the SAME config — sdk#1113 predicts
    // the servers are silently dropped here.
    const events2 = []
    const s2 = await client.resumeSession(sessionId, config())
    rec('meta', { phase: 'resume', sessionId: s2.sessionId, sameId: s2.sessionId === sessionId })
    s2.on((e) => events2.push(e))
    wireAllEvents(s2, rec)
    const final2 = await s2.sendAndWait(PROMPT, 120000)
    const text2 = Array.isArray(final2?.data?.content)
      ? final2.data.content.map((c) => c?.text ?? '').join('')
      : String(final2?.data?.content ?? '')
    summarize(rec, 'resume', events2, text2)
    await s2.disconnect()
  })
  await stop(client)
}
