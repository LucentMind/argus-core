// Shared harness for the Copilot SDK empirical spike (Task 7).
//
// Every scenario module imports these helpers. The contract:
//   - `newClient(overrides)` builds a CopilotClient pinned to the scratch
//     COPILOT_HOME (`.copilot-home/`), never ~/.copilot.
//   - `recorder(scenario)` returns `{ rec, path }`. `rec(kind, data)` appends
//     one JSON line `{scenario, t, kind, data}` to the committed fixture file
//     `src/main/services/agent/drivers/copilot/__fixtures__/<scenario>.jsonl`.
//   - `wireAllEvents(session, rec)` records EVERY session event.
//   - `sandboxDir()` returns a throwaway git working dir for the agent.
//
// Node 22 ESM, no TS build step (see probe.mjs for the working pattern).
import { CopilotClient } from '@github/copilot-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SCRATCH_HOME = path.join(HERE, '.copilot-home')
export const SANDBOX = path.join(HERE, 'sandbox')
export const FIXTURES_DIR = path.resolve(
  HERE,
  '..',
  '..',
  'src',
  'main',
  'services',
  'agent',
  'drivers',
  'copilot',
  '__fixtures__'
)

fs.mkdirSync(SCRATCH_HOME, { recursive: true })
fs.mkdirSync(FIXTURES_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Safe serialization: strip circular refs, coerce Errors/BigInt/functions, and
// redact anything that looks like a GitHub token so it can never land on disk.
// ---------------------------------------------------------------------------
const TOKEN_RE = /gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g

function scrub(value) {
  if (typeof value === 'string') return value.replace(TOKEN_RE, '[REDACTED_TOKEN]')
  return value
}

function safeReplacer() {
  const seen = new WeakSet()
  return function (key, val) {
    // Belt-and-suspenders: never serialize obvious secret-bearing keys.
    if (/token|secret|apiKey|authorization|bearer/i.test(key) && typeof val === 'string') {
      return '[REDACTED_KEY]'
    }
    if (typeof val === 'bigint') return val.toString()
    if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`
    if (val instanceof Error) {
      return { name: val.name, message: scrub(val.message), stack: scrub(val.stack), code: val.code }
    }
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
    }
    return scrub(val)
  }
}

export function recorder(scenario) {
  const file = path.join(FIXTURES_DIR, `${scenario}.jsonl`)
  fs.writeFileSync(file, '') // fresh each run so fixtures are deterministic
  const rec = (kind, data) => {
    let line
    try {
      line = JSON.stringify({ scenario, t: new Date().toISOString(), kind, data }, safeReplacer())
    } catch (err) {
      line = JSON.stringify({
        scenario,
        t: new Date().toISOString(),
        kind: 'error',
        data: { serializationError: String(err?.message ?? err), forKind: kind }
      })
    }
    fs.appendFileSync(file, line + '\n')
  }
  return { rec, path: file }
}

export function newClient(overrides = {}) {
  return new CopilotClient({
    baseDirectory: SCRATCH_HOME,
    logLevel: 'error',
    ...overrides
  })
}

// Record every session event verbatim (envelope kind: 'event').
export function wireAllEvents(session, rec) {
  session.on((event) => {
    // Skip high-volume streaming deltas' payload duplication? No — capture all;
    // prompts are tiny so volume is bounded and delta shape is evidence.
    rec('event', event)
  })
}

// Create a throwaway git repo the agent can operate in. Idempotent.
export function sandboxDir() {
  fs.mkdirSync(SANDBOX, { recursive: true })
  const gitDir = path.join(SANDBOX, '.git')
  if (!fs.existsSync(gitDir)) {
    const run = (args) => execFileSync('git', args, { cwd: SANDBOX, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'spike@example.com'])
    run(['config', 'user.name', 'Spike'])
    fs.writeFileSync(path.join(SANDBOX, 'README.md'), '# sandbox\nA throwaway repo for the Copilot spike.\n')
    fs.writeFileSync(path.join(SANDBOX, 'notes.txt'), 'line one\nline two\n')
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'seed'])
  }
  return SANDBOX
}

// Approve ONLY an expected operation inside the sandbox; deny everything else.
// The deny path is itself evidence, so callers pass `rec` to capture decisions.
export function sandboxGuard(rec, predicate) {
  return async (request, invocation) => {
    rec('permission-request', { request, invocation })
    let decision
    try {
      decision = predicate(request)
    } catch (err) {
      decision = { kind: 'reject', feedback: `guard error: ${String(err?.message ?? err)}` }
    }
    if (!decision) decision = { kind: 'reject', feedback: 'not the expected sandbox operation' }
    rec('permission-decision', { kind: request?.kind, decision })
    return decision
  }
}

export async function stop(client) {
  try {
    await client.forceStop?.()
  } catch {
    /* ignore */
  }
}

// Small helper: run body, capture thrown errors into the fixture, never throw.
export async function guarded(rec, label, body) {
  try {
    await body()
  } catch (err) {
    rec('error', { label, name: err?.name, message: scrub(String(err?.message ?? err)), code: err?.code })
  }
}
