// Scenario 13 (Task 9B): bounded retry of the open MCP question (§6, open question 1).
// Task-7 scenario 06 showed an SDK-declared stdio mcpServers config loading
// `status:"not_configured"` and never exposing its tool. This scenario tries the three
// candidate fixes empirically and records, per variant, the mcp_servers_loaded status +
// whether the model could actually see/call the `mcp_echo` tool:
//   A) enableConfigDiscovery:true + SDK-declared mcpServers
//   B) a `.mcp.json` written into the workingDirectory (+ enableConfigDiscovery)
//   C) client mode:"empty" + explicit availableTools + SDK-declared mcpServers
//
// Verdict (SOLVED/NOT SOLVED) is decided from this fixture and written into EVIDENCE §6b.
import fs from 'node:fs'
import path from 'node:path'
import { CopilotClient } from '@github/copilot-sdk'
import {
  recorder,
  wireAllEvents,
  sandboxDir,
  sandboxGuard,
  stop,
  guarded,
  HERE,
  SCRATCH_HOME
} from '../lib.mjs'

const SERVER = path.join(HERE, 'mcp-echo-server.mjs')
const PROMPT =
  "List your available tools that come from the 'argusEcho' MCP server. If a tool named " +
  "mcp_echo exists, call it with message 'ping' and report exactly what it returned. " +
  'If you have no such tool, say exactly: NO_MCP_TOOL.'

/** Record the tool-visibility outcome for one variant: the mcp_servers_loaded statuses and
 *  whether the final answer indicates the tool was reachable. */
function summarize(rec, variant, events, finalText) {
  const loaded = events
    .filter((e) => e?.type === 'session.mcp_servers_loaded')
    .flatMap((e) => e?.data?.servers ?? [])
  const sawTool = /mcp-echo:ping/i.test(finalText ?? '') || /mcp_echo/i.test(finalText ?? '')
  const declaredNoTool = /NO_MCP_TOOL/i.test(finalText ?? '')
  rec('result', {
    variant,
    mcpServersLoaded: loaded,
    finalText,
    toolReachable: sawTool && !declaredNoTool
  })
}

async function runVariant(rec, variant, { clientOptions = {}, sessionExtra = {}, mcpJson = false }) {
  const events = []
  const client = new CopilotClient({
    baseDirectory: SCRATCH_HOME,
    logLevel: 'error',
    ...clientOptions
  })
  await guarded(rec, variant, async () => {
    await client.start()
    const workdir = sandboxDir()
    const mcpServers = {
      argusEcho: { type: 'stdio', command: process.execPath, args: [SERVER] }
    }
    if (mcpJson) {
      // Candidate B: a project-level .mcp.json the runtime may auto-discover.
      fs.writeFileSync(
        path.join(workdir, '.mcp.json'),
        JSON.stringify({ mcpServers }, null, 2)
      )
    }
    const config = {
      workingDirectory: workdir,
      streaming: true,
      mcpServers,
      onPermissionRequest: sandboxGuard(rec, (request) => {
        if (request?.kind === 'mcp' && request.serverName === 'argusEcho')
          return { kind: 'approve-once' }
        if (request?.kind === 'read' || request?.kind === 'custom-tool')
          return { kind: 'approve-once' }
        return { kind: 'reject', feedback: 'only argusEcho mcp approved' }
      }),
      ...sessionExtra
    }
    rec('meta', { variant, configSent: { clientOptions, config: { ...config, onPermissionRequest: '[fn]' } } })
    const session = await client.createSession(config)
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
  const { rec } = recorder('13-mcp-retry')
  // A) enableConfigDiscovery on the session with an SDK-declared mcpServers map.
  await runVariant(rec, 'A-enableConfigDiscovery', {
    sessionExtra: { enableConfigDiscovery: true }
  })
  // B) a discovered .mcp.json in the working directory.
  await runVariant(rec, 'B-dot-mcp-json', {
    mcpJson: true,
    sessionExtra: { enableConfigDiscovery: true }
  })
  // C) client mode:"empty" + explicit availableTools admitting mcp + custom tools.
  await runVariant(rec, 'C-empty-mode-availableTools', {
    clientOptions: { mode: 'empty' },
    sessionExtra: { availableTools: ['mcp:*', 'custom:*', 'view', 'read'] }
  })
}
