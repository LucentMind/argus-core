#!/usr/bin/env node
/**
 * Claude Agent SDK branching spike — records REAL SDK behaviour for session fork + file rewind.
 * Writes JSONL fixtures next to drivers/claude/__fixtures__ and prints Q1-Q3 verdicts.
 *
 * Usage (from app/):  node scripts/spike-claude-branch/run.mjs
 * Needs a logged-in `claude` CLI (or ANTHROPIC_API_KEY). Costs a few cents.
 *
 * Deviation from the plan's draft script, forced by what the first run showed:
 *  - The draft yielded both turn prompts from one AsyncIterable without waiting. The CLI
 *    QUEUES the second message and injects it mid-turn: the transcript had ONE user entry
 *    and ONE `result`, so there was no "turn 2" to fork away from or rewind to. Turn 2's
 *    prompt is now gated on turn 1's `result`.
 *  - `result` carried no `user_message_uuid`, so the draft passed `null` to rewindFiles and
 *    got "No file checkpoint found for this message" — a vacuous Q2 answer. The script now
 *    logs every key of every message and also reads the CLI transcript, so the rewind is
 *    driven by a real user-message uuid whatever its source turns out to be.
 *  - The draft's idle-control-query shape is still tried first (Q2 as asked); the held-open
 *    shape is tried as well so the fixture records both.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { query, forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.resolve(HERE, '../../src/main/services/agent/drivers/claude/__fixtures__')
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-branch-spike-'))
const target = path.join(cwd, 'note.txt')

function recorder(file) {
  const out = fs.createWriteStream(path.join(FIX, file))
  const t0 = Date.now()
  return {
    log: (scenario, kind, data) =>
      out.write(JSON.stringify({ scenario, t: Date.now() - t0, kind, data }) + '\n'),
    close: () => new Promise((r) => out.end(r))
  }
}

/**
 * AsyncIterable of user prompts where prompt i is only yielded after `open(i)` is called.
 * Prompt 0 is open from the start; the caller opens the next one when turn i's `result`
 * arrives, so each prompt becomes its own turn instead of being queued into the current one.
 */
function gatedPrompts(texts) {
  const gates = texts.map(() => {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    return { promise, resolve }
  })
  gates[0].resolve()
  async function* gen() {
    for (let i = 0; i < texts.length; i++) {
      await gates[i].promise
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: texts[i] }] },
        parent_tool_use_id: null,
        session_id: ''
      }
    }
  }
  return { iter: gen(), open: (i) => gates[i]?.resolve() }
}

/**
 * An AsyncIterable that is already finished — the "idle control query" shape (Q2).
 * The empty body IS the shape under test, so the rule is disabled rather than the
 * shape rewritten.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function
async function* nothing() {}

/** An AsyncIterable that never ends until `end()` — the "held-open control query" shape (Q2). */
function heldOpen() {
  let release
  const done = new Promise((r) => (release = r))
  // Never yields by design: it only has to keep the CLI's stdin open. Same reasoning as above.
  // eslint-disable-next-line require-yield
  async function* gen() {
    await done
  }
  return { iter: gen(), end: () => release() }
}

/** The CLI transcript for a session, as parsed JSONL entries (or [] if not found). */
function transcriptEntries(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(root)) return []
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(p))
      return fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .filter(Boolean)
  }
  return []
}

const base = {
  cwd,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  enableFileCheckpointing: true,
  includePartialMessages: false
}

const read = () => {
  try {
    return fs.readFileSync(target, 'utf8').trim()
  } catch (err) {
    return `<unreadable: ${err?.code ?? err}>`
  }
}

/**
 * Every live CLI child, as {pid, name}. The SDK spawns the Claude Code executable as a
 * child of this node process; disposal is proved by that pid disappearing, so the census
 * must come from the OS, not from anything the SDK reports about itself.
 */
function cliProcesses() {
  try {
    if (process.platform === 'win32') {
      const ps =
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'claude' } | " +
        'ForEach-Object { "$($_.ProcessId)|$($_.Name)" }'
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
      })
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [pid, name] = l.split('|')
          return { pid: Number(pid), name }
        })
    }
    const out = execFileSync('ps', ['-eo', 'pid=,comm='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    return out
      .split('\n')
      .filter((l) => /claude|node/i.test(l))
      .map((l) => l.trim().split(/\s+/))
      .map(([pid, name]) => ({ pid: Number(pid), name }))
  } catch (err) {
    console.error(`census failed: ${err?.message ?? err}`)
    return []
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** An AsyncQueue-equivalent held-open prompt — the exact shape branch.ts's controlQuery uses. */
function heldQueue() {
  let resolve = null
  let ended = false
  return {
    end: () => {
      ended = true
      if (resolve) resolve({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]: () => ({
      next: () =>
        ended
          ? Promise.resolve({ value: undefined, done: true })
          : new Promise((r) => (resolve = r))
    })
  }
}

/**
 * Step 6: does the disposal sequence branch.ts ships actually end the CLI child?
 * Task 1 recorded that after `close()` a live child was left behind. Each candidate gets
 * its OWN control query (branch.ts's shape: held-open prompt, resumed, dry-run rewind),
 * then the sequence, then a 5 s poll of the pids that query spawned.
 */
async function disposeScenario() {
  const rec = recorder('branch-dispose.jsonl')
  // A one-turn seed session so the control query has something real to resume and a real
  // user-message id to dry-run against. Cheap: one sentence, no tools.
  const seedPrompt = gatedPrompts(['Reply with exactly: ok'])
  const seed = query({ prompt: seedPrompt.iter, options: base })
  let sessionId = null
  for await (const msg of seed) {
    if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id
    if (msg.type === 'result') break
  }
  const msgs = await getSessionMessages(sessionId, { dir: cwd })
  const userMessageId = msgs.find((m) => m.type === 'user')?.uuid ?? null
  rec.log('dispose', 'seed', { sessionId, userMessageId, messageCount: msgs.length })
  await sleep(2000) // let the seed query's own child settle so it is not mistaken for ours

  const candidates = [
    {
      name: 'end-then-close',
      run: async (held, ctl) => {
        held.end()
        ctl.close()
      }
    },
    {
      name: 'end-tick-close',
      run: async (held, ctl) => {
        held.end()
        await sleep(0)
        ctl.close()
      }
    },
    {
      name: 'end-drain-close',
      run: async (held, ctl) => {
        held.end()
        await Promise.race([
          (async () => {
            for await (const _ of ctl) void _
          })().catch(() => undefined),
          sleep(3000)
        ])
        ctl.close()
      }
    },
    {
      name: 'interrupt-then-close',
      run: async (held, ctl) => {
        held.end()
        await ctl.interrupt().catch(() => undefined)
        ctl.close()
      }
    },
    {
      name: 'close-then-end',
      run: async (held, ctl) => {
        ctl.close()
        held.end()
      }
    },
    // The falsification control, and the reason the verdicts above mean anything: a
    // control query that is NOT released must still be alive at the end of the same 5 s
    // poll. If this one exited too, the poll would be measuring something other than
    // disposal (an idle timeout, a bad census) and every "EXITED" above would be vacuous.
    {
      name: 'control-no-release',
      run: async (held, ctl) => {
        void held
        void ctl
      },
      after: async (held, ctl) => {
        held.end()
        ctl.close()
      }
    }
  ]

  for (const c of candidates) {
    const before = new Set(cliProcesses().map((p) => p.pid))
    const held = heldQueue()
    const ctl = query({ prompt: held, options: { ...base, resume: sessionId } })
    let dry = null
    try {
      dry = await ctl.rewindFiles(userMessageId, { dryRun: true })
    } catch (err) {
      dry = { threw: String(err?.message ?? err) }
    }
    const spawned = cliProcesses().filter((p) => !before.has(p.pid))
    await c.run(held, ctl)
    // Poll for up to 5 s: are any of the pids this query spawned still alive?
    let survivors = spawned.map((p) => p.pid)
    let waitedMs = 0
    while (survivors.length > 0 && waitedMs < 5000) {
      await sleep(500)
      waitedMs += 500
      const live = new Set(cliProcesses().map((p) => p.pid))
      survivors = survivors.filter((pid) => live.has(pid))
    }
    await c.after?.(held, ctl) // the control's own cleanup, so nothing is orphaned
    rec.log('dispose', c.name, {
      dryRun: dry,
      pidsBefore: before.size,
      spawned,
      survivorsAfter: survivors,
      exited: survivors.length === 0,
      waitedMs
    })
    console.log(
      `dispose ${c.name}: spawned ${JSON.stringify(spawned.map((p) => `${p.pid}/${p.name}`))} -> ` +
        `${survivors.length === 0 ? 'EXITED' : `SURVIVED ${JSON.stringify(survivors)}`} after ${waitedMs}ms`
    )
    await sleep(500)
  }
  await rec.close()
  console.log(`dispose fixture written to ${FIX}; scratch cwd ${cwd}`)
}

// `--dispose-only` runs Step 6 alone, so the (already committed) Q1-Q3 fixtures are not
// re-captured — that costs money and would churn three redacted files for nothing.
if (process.argv.includes('--dispose-only')) {
  await disposeScenario()
  process.exit(0)
}

// ---- Scenario A: a two-turn session that edits a file in each turn ----
const rec = recorder('branch-session.jsonl')
let sessionId = null
const assistantUuidsByTurn = [[], []]
const userMsgUuidByTurn = [null, null]
const fileAfterTurn = [null, null]
let turn = 0
const gated = gatedPrompts([
  `Create the file ${target} containing exactly the line "v1". Reply "done".`,
  `Overwrite ${target} so it contains exactly the line "v2". Reply "done".`
])
const q = query({ prompt: gated.iter, options: base })
for await (const msg of q) {
  rec.log('session', msg.type, {
    turn,
    subtype: msg.subtype,
    uuid: msg.uuid,
    session_id: msg.session_id,
    // Every key the message actually carries — the point of the capture is to see what is
    // really there, not what sdk.d.ts says should be.
    keys: Object.keys(msg).sort(),
    user_message_uuid: msg.user_message_uuid ?? null,
    parent_tool_use_id: msg.parent_tool_use_id ?? null,
    blocks: Array.isArray(msg.message?.content)
      ? msg.message.content.map((b) => b.type).join(',')
      : typeof msg.message?.content === 'string'
        ? 'string'
        : undefined,
    text:
      msg.type === 'assistant' && Array.isArray(msg.message?.content)
        ? msg.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .slice(0, 120)
        : undefined
  })
  if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id
  if (msg.type === 'assistant') assistantUuidsByTurn[turn].push(msg.uuid)
  if (msg.type === 'result') {
    userMsgUuidByTurn[turn] = msg.user_message_uuid ?? null
    fileAfterTurn[turn] = read()
    turn++
    if (turn === 2) break
    gated.open(turn) // release the next prompt only now: one prompt per turn
  }
}

// What the CLI transcript says the user-message uuids are, for comparison with `result`.
const userEntries = transcriptEntries(sessionId)
  .filter(
    (e) =>
      e.type === 'user' &&
      Array.isArray(e.message?.content) &&
      e.message.content.some((b) => b.type === 'text')
  )
  .map((e) => ({
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    text: e.message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .slice(0, 60)
  }))
rec.log('session', 'transcript_user_entries', userEntries)
rec.log('session', 'summary', {
  sessionId,
  assistantUuidsByTurn,
  userMsgUuidByTurn,
  fileAfterTurn
})
await rec.close()

const anchor = assistantUuidsByTurn[0].at(-1) // last assistant message of turn 1
// The id rewindFiles needs: prefer `result.user_message_uuid`, fall back to the transcript.
const turn2UserUuid = userMsgUuidByTurn[1] ?? userEntries[1]?.uuid ?? null
const turn2UuidSource = userMsgUuidByTurn[1]
  ? 'result.user_message_uuid'
  : userEntries[1]?.uuid
    ? 'transcript'
    : 'none'
const q1 = assistantUuidsByTurn.flat().every(Boolean) && userMsgUuidByTurn.every(Boolean)
console.log(`Q1 uuids present on every assistant + user_message_uuid on every result: ${q1}`)
console.log(
  `   anchor (turn 1 last assistant) = ${anchor}; turn-2 user uuid = ${turn2UserUuid} (from ${turn2UuidSource})`
)
console.log(`   file after turn 1 = ${fileAfterTurn[0]}; after turn 2 = ${fileAfterTurn[1]}`)

// ---- Scenario B: control query + rewindFiles (Q2) ----
const rew = recorder('branch-rewind.jsonl')
rew.log('rewind', 'input', {
  userMessageId: turn2UserUuid,
  source: turn2UuidSource,
  resume: sessionId
})

// B1 — the shape the plan asks about first: prompt AsyncIterable already ended.
let q2 = 'unknown'
try {
  const ctl = query({ prompt: nothing(), options: { ...base, resume: sessionId } })
  const dry = await ctl.rewindFiles(turn2UserUuid, { dryRun: true })
  rew.log('rewind-idle', 'dryRun', dry)
  const real = await ctl.rewindFiles(turn2UserUuid)
  rew.log('rewind-idle', 'real', real)
  ctl.close()
  const after = read()
  rew.log('rewind-idle', 'file', { before: fileAfterTurn[1], after })
  q2 = after === 'v1' ? 'yes' : `no (file is "${after}")`
} catch (err) {
  rew.log('rewind-idle', 'error', { message: String(err?.message ?? err) })
  q2 = `no (threw: ${err?.message ?? err})`
}

// B2 — the fallback shape: prompt AsyncIterable stays open across the control requests.
// Recorded unconditionally so the fixture shows both shapes on the same session.
let q2b = 'unknown'
try {
  fs.writeFileSync(target, 'v2\n') // same starting state as B1 had, whatever B1 did
  const held = heldOpen()
  const ctl2 = query({ prompt: held.iter, options: { ...base, resume: sessionId } })
  const dry2 = await ctl2.rewindFiles(turn2UserUuid, { dryRun: true })
  rew.log('rewind-heldopen', 'dryRun', dry2)
  const real2 = await ctl2.rewindFiles(turn2UserUuid)
  rew.log('rewind-heldopen', 'real', real2)
  held.end()
  ctl2.close()
  const after2 = read()
  rew.log('rewind-heldopen', 'file', { before: 'v2', after: after2 })
  q2b = after2 === 'v1' ? 'yes' : `no (file is "${after2}")`
} catch (err) {
  rew.log('rewind-heldopen', 'error', { message: String(err?.message ?? err) })
  q2b = `no (threw: ${err?.message ?? err})`
}
await rew.close()
console.log(`Q2  idle control query (ended stdin) answers rewindFiles and restores v1: ${q2}`)
console.log(`Q2b held-open control query answers rewindFiles and restores v1: ${q2b}`)

// ---- Scenario C: forkSession up to the anchor, resume the fork, probe its memory (Q3) ----
const frk = recorder('branch-fork.jsonl')
let q3 = 'unknown'
try {
  const { sessionId: forkId } = await forkSession(sessionId, { upToMessageId: anchor, dir: cwd })
  frk.log('fork', 'forked', { from: sessionId, forkId, anchor })
  const forkTail = transcriptEntries(forkId).map((e) => ({
    type: e.type,
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    text: Array.isArray(e.message?.content)
      ? e.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .slice(0, 60)
      : undefined
  }))
  frk.log('fork', 'fork_transcript', forkTail)
  const fp = gatedPrompts([
    'In one line: what was the FIRST thing I asked you, and did I ever ask for "v2"?'
  ])
  const fq = query({ prompt: fp.iter, options: { ...base, resume: forkId } })
  let reply = ''
  for await (const msg of fq) {
    frk.log('fork', msg.type, { subtype: msg.subtype, uuid: msg.uuid, session_id: msg.session_id })
    if (msg.type === 'assistant')
      reply += msg.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
    if (msg.type === 'result') break
  }
  frk.log('fork', 'reply', { reply })
  q3 = /v1/.test(reply) && !/yes.*v2|asked.*v2/i.test(reply) ? 'yes' : `check reply: ${reply}`
} catch (err) {
  frk.log('fork', 'error', { message: String(err?.message ?? err) })
  q3 = `no (threw: ${err?.message ?? err})`
}

// Does forkSession find the session WITHOUT `dir`? (the plan asks; the driver needs to know)
try {
  const { sessionId: forkId2 } = await forkSession(sessionId, { upToMessageId: anchor })
  frk.log('fork-no-dir', 'forked', { forkId: forkId2 })
} catch (err) {
  frk.log('fork-no-dir', 'error', { message: String(err?.message ?? err) })
}
await frk.close()
console.log(`Q3 forkSession(upToMessageId, dir) + resume knows turn 1 only: ${q3}`)
console.log(`fixtures written to ${FIX}; scratch cwd ${cwd}`)
// The SDK leaves a live CLI child behind after close(); without this the process never exits.
process.exit(0)
