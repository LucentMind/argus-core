// ACP protocol + library spike harness (Task 1 of the "ACP multi-agent
// driver" plan). Spawns a real agent CLI in ACP mode, connects to it as an
// ACP Client using the real `@zed-industries/agent-client-protocol@0.4.5`
// API, and records every inbound JSON-RPC message (plus the outbound
// requests/notifications we sent) to a per-scenario JSONL fixture under
// `src/main/services/agent/drivers/acp/__fixtures__/<agent>/`.
//
// STATUS: written but NOT run in this environment — neither `cursor-agent`
// nor `grok`, nor their API keys, are available here (owner-approved
// "build now, defer live capture"; see `__fixtures__/EVIDENCE.md`). This is
// a throwaway-but-kept harness: rerun it later, from `app/`, once binaries
// and keys exist:
//
//   CURSOR_API_KEY=<key> AGENT=cursor ./node_modules/.bin/electron scripts/acp-spike.mjs
//   XAI_API_KEY=<key>    AGENT=grok   ./node_modules/.bin/electron scripts/acp-spike.mjs
//
// Use `./node_modules/.bin/electron`, not bare `node` — some agent CLIs are
// Node-based launchers that can die silently under Electron's main process
// if spawned incorrectly (see `argus-electron-execpath-spawn-trap` in
// project memory); running the capture the same way the real app will run
// it is the point of the spike.
//
// Library API notes (confirmed empirically against the installed 0.4.5 —
// see EVIDENCE.md §1-§5 for full citations):
//   - There is NO fluent `client()` API in this version. The Client-role
//     entry point is the `ClientSideConnection` class.
//   - `ClientSideConnection` needs a `Stream` (a Web Streams
//     {readable, writable} pair of JSON-RPC messages), built here via the
//     library's `ndJsonStream()` wrapped around the spawned child's stdio
//     converted to Web Streams with Node's `Writable.toWeb`/`Readable.toWeb`.
//   - The `Client` interface's only REQUIRED methods are `requestPermission`
//     and `sessionUpdate`; `readTextFile`/`writeTextFile` are optional but
//     implemented here since we advertise `fs` capabilities at `initialize`.
//   - `session/update`'s discriminator field is `sessionUpdate`; the 8 real
//     variant values are `user_message_chunk`, `agent_message_chunk`,
//     `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
//     `available_commands_update`, `current_mode_update`.
//   - Permission response `outcome` is `{outcome:'selected', optionId}` or
//     `{outcome:'cancelled'}` — never a bare optionId string.
//
// Usage: AGENT=cursor node scripts/acp-spike.mjs   (or AGENT=grok)

import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION
} from '@zed-industries/agent-client-protocol'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(
  HERE,
  '..',
  'src',
  'main',
  'services',
  'agent',
  'drivers',
  'acp',
  '__fixtures__'
)
const SANDBOX = path.join(HERE, '.acp-spike-sandbox')

// ---------------------------------------------------------------------------
// Per-agent launch profile. Everything here is ASSUMED / UNVERIFIED until a
// live run reconciles it against the real CLI — see EVIDENCE.md's "ASSUMED"
// section. Adjust before the first real capture.
// ---------------------------------------------------------------------------
const PROFILES = {
  cursor: {
    command: 'cursor-agent',
    args: ['acp'], // ASSUMED (t3code-observed per the plan; unverified here)
    authEnvVar: 'CURSOR_API_KEY'
  },
  grok: {
    command: 'grok',
    args: ['agent', 'stdio'], // ASSUMED
    authEnvVar: 'XAI_API_KEY'
  }
}

const AGENT = process.env.AGENT
const profile = PROFILES[AGENT]
if (!profile) {
  console.error('Usage: AGENT=cursor|grok node scripts/acp-spike.mjs')
  process.exit(1)
}

const outDir = path.join(FIXTURES_DIR, AGENT)
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(SANDBOX, { recursive: true })
const sandboxFile = path.join(SANDBOX, 'notes.txt')
if (!fs.existsSync(sandboxFile)) {
  fs.writeFileSync(sandboxFile, 'line one\n')
}

// ---------------------------------------------------------------------------
// Fixture recorder — one JSONL file per scenario, one line per JSON-RPC
// message crossing the wire (direction: inbound = from agent, outbound-*
// = what we sent).
// ---------------------------------------------------------------------------
function recorder(scenario) {
  const file = path.join(outDir, `${scenario}.jsonl`)
  fs.writeFileSync(file, '') // fresh each run so fixtures are deterministic
  return (direction, message) => {
    const line = JSON.stringify({ t: new Date().toISOString(), direction, message })
    fs.appendFileSync(file, line + '\n')
  }
}

// Wraps a spawned child's stdio into the library's Stream (Web Streams API).
// The library only ships `ndJsonStream(output: WritableStream<Uint8Array>,
// input: ReadableStream<Uint8Array>)` — the Node-stream -> Web-stream
// conversion is on us.
function streamFor(child) {
  return ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
}

// Builds the `Client` implementation the plan's driver will eventually
// provide. Permission requests are auto-allowed (prefer `allow_once`, then
// `allow_always`, else whatever option is first) so scenarios run
// unattended; every inbound message is still recorded before we decide.
function makeClient(rec) {
  return (_agent) => ({
    async requestPermission(params) {
      rec('inbound', { method: 'session/request_permission', params })
      const options = params.options ?? []
      const chosen =
        options.find((o) => o.kind === 'allow_once') ??
        options.find((o) => o.kind === 'allow_always') ??
        options[0]
      const outcome = chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' }
      rec('outbound-response', { method: 'session/request_permission', outcome })
      return { outcome }
    },
    async sessionUpdate(params) {
      rec('inbound', { method: 'session/update', params })
    },
    async readTextFile(params) {
      rec('inbound', { method: 'fs/read_text_file', params })
      const content = fs.existsSync(params.path) ? fs.readFileSync(params.path, 'utf8') : ''
      return { content }
    },
    async writeTextFile(params) {
      rec('inbound', { method: 'fs/write_text_file', params })
      fs.writeFileSync(params.path, params.content, 'utf8')
      return {}
    },
    // Capture anything vendor-specific (e.g. an xAI/Grok extension) rather
    // than throwing method-not-found.
    async extMethod(method, params) {
      rec('inbound', { method: `_${method}`, params })
      return {}
    },
    async extNotification(method, params) {
      rec('inbound', { method: `_${method}`, params })
    }
  })
}

async function runScenario(name, { withAuth = true } = {}) {
  const rec = recorder(name)
  const env = { ...process.env }
  if (!withAuth) delete env[profile.authEnvVar]

  const child = spawn(profile.command, profile.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', (chunk) => rec('stderr', chunk.toString()))
  child.on('error', (err) => rec('spawn-error', { message: String(err?.message ?? err) }))

  const connection = new ClientSideConnection(makeClient(rec), streamFor(child))

  try {
    const initParams = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }
    }
    rec('outbound-request', { method: 'initialize', params: initParams })
    const initResult = await connection.initialize(initParams)
    rec('inbound', { method: 'initialize#response', result: initResult })

    const newSessionParams = { cwd: SANDBOX, mcpServers: [] }
    rec('outbound-request', { method: 'session/new', params: newSessionParams })
    const session = await connection.newSession(newSessionParams)
    rec('inbound', { method: 'session/new#response', result: session })

    const promptParams = {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Append a new line to notes.txt, then stop.' }]
    }
    rec('outbound-request', { method: 'session/prompt', params: promptParams })
    const promptResult = await connection.prompt(promptParams)
    rec('inbound', { method: 'session/prompt#response', result: promptResult })

    // Exercise cancel as its own recorded path (best-effort — the turn above
    // may already be complete by the time this fires).
    rec('outbound-notification', { method: 'session/cancel', params: { sessionId: session.sessionId } })
    await connection.cancel({ sessionId: session.sessionId })
  } catch (err) {
    rec('error', { message: String(err?.message ?? err), code: err?.code })
  } finally {
    child.kill()
  }
}

async function main() {
  await runScenario('01-handshake-and-permission', { withAuth: true })
  await runScenario('02-auth-failure', { withAuth: false })
  console.log(`Wrote fixtures to ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
