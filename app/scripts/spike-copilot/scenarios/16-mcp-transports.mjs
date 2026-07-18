// Scenario 16: resolution of the §6/§6b stdio-MCP failure ("not_configured").
// Hypothesis under test: MCPServerConfigBase.tools ("undefined ... means include
// all tools" per the .d.ts) is empirically REQUIRED — §6/§6b variants never set
// it. Four variants, each asking the model to list/call `mcp_echo` from the
// SDK-declared `argusEcho` server:
//   A) stdio + tools:["*"]                      — the fix candidate
//   B) type:"http" (Streamable HTTP) + tools:["*"] — transport workaround
//   C) type:"sse"  (legacy HTTP+SSE) + tools:["*"] — transport workaround
//   D) stdio, NO tools field                    — control; §6 predicts not_configured
// The HTTP server logs every inbound request into the fixture; the sandbox is
// scrubbed of any .mcp.json beforehand so discovery can't contaminate results.
import fs from 'node:fs'
import path from 'node:path'
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded, HERE } from '../lib.mjs'
import { startHttpEcho } from '../mcp-echo-http-server.mjs'

const STDIO_SERVER = path.join(HERE, 'mcp-echo-server.mjs')
const PROMPT =
  "List your available tools that come from the 'argusEcho' MCP server. If a tool named " +
  "mcp_echo exists, call it with message 'ping' and report exactly what it returned. " +
  'If you have no such tool, say exactly: NO_MCP_TOOL.'

function summarize(rec, variant, events, finalText) {
  const loaded = events
    .filter((e) => e?.type === 'session.mcp_servers_loaded')
    .flatMap((e) => e?.data?.servers ?? [])
  const echoed = /mcp-echo:ping/i.test(finalText ?? '')
  const declaredNoTool = /NO_MCP_TOOL/i.test(finalText ?? '')
  rec('result', {
    variant,
    mcpServersLoaded: loaded,
    finalText,
    toolReachable: echoed && !declaredNoTool
  })
}

async function runVariant(rec, variant, mcpServers) {
  const events = []
  const client = newClient()
  await guarded(rec, variant, async () => {
    await client.start()
    rec('meta', { variant, configSent: { mcpServers } })
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      mcpServers,
      onPermissionRequest: sandboxGuard(rec, (request) => {
        if (request?.kind === 'mcp' && request.serverName === 'argusEcho') return { kind: 'approve-once' }
        if (request?.kind === 'read') return { kind: 'approve-once' }
        return { kind: 'reject', feedback: 'only argusEcho mcp approved' }
      })
    })
    session.on((e) => events.push(e))
    wireAllEvents(session, rec)
    const final = await session.sendAndWait(PROMPT, 120000)
    const finalText = Array.isArray(final?.data?.content)
      ? final.data.content.map((c) => c?.text ?? '').join('')
      : String(final?.data?.content ?? '')
    summarize(rec, variant, events, finalText)
    await session.disconnect()
  })
  await stop(client)
}

export default async function run() {
  const { rec } = recorder('16-mcp-transports')

  // Ensure no discovered config can contaminate the SDK-declared-only variants.
  const staleMcpJson = path.join(sandboxDir(), '.mcp.json')
  if (fs.existsSync(staleMcpJson)) fs.rmSync(staleMcpJson)

  // A) stdio with an explicit tools allowlist — the fix candidate.
  await runVariant(rec, 'A-stdio-tools-star', {
    argusEcho: { type: 'stdio', command: process.execPath, args: [STDIO_SERVER], tools: ['*'] }
  })

  // B/C share one live HTTP server; its request log is fixture evidence.
  const httpServer = await startHttpEcho((entry) => rec('http-request', entry))
  rec('meta', { httpUrl: httpServer.httpUrl, sseUrl: httpServer.sseUrl })
  try {
    await runVariant(rec, 'B-http-streamable', {
      argusEcho: { type: 'http', url: httpServer.httpUrl, tools: ['*'] }
    })
    await runVariant(rec, 'C-sse-legacy', {
      argusEcho: { type: 'sse', url: httpServer.sseUrl, tools: ['*'] }
    })
  } finally {
    await httpServer.close()
  }

  // D) control: identical to §6's failing config (stdio, no tools field).
  await runVariant(rec, 'D-stdio-no-tools', {
    argusEcho: { type: 'stdio', command: process.execPath, args: [STDIO_SERVER] }
  })
}
