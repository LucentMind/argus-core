// Probe (transcript-only half): derive per-turn anchors from a CLI transcript, check them against
// stream-observed ground truth, and check them across REAL forks at every turn boundary.
//
//   node scripts/spike-claude-branch/derive-transcript.mjs <sessionId> <cwd> [--truth a,b,..] [--fork] [--dump]
//
// `--truth` = last-assistant-uuid prefixes per turn as the driver saw them on the stream
// (the value `turns.provider_anchor_id` stores). `--fork` forks at each derived anchor, re-derives
// on the fork, and deletes the fork.
import { getSessionMessages, forkSession, deleteSession } from '@anthropic-ai/claude-agent-sdk'

const [sessionId, dirArg] = process.argv.slice(2)
const dir = dirArg === '-' ? undefined : dirArg // '-' = search every project dir
const flag = (n) => process.argv.includes(n)
const truthAt = process.argv.indexOf('--truth')
const truth = truthAt < 0 ? [] : (process.argv[truthAt + 1] ?? '').split(',').filter(Boolean)

const textOf = (m) => {
  const c = m.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
  return ''
}
const hasToolResult = (m) =>
  Array.isArray(m.message?.content) && m.message.content.some((b) => b?.type === 'tool_result')
const isPrompt = (m) =>
  m.type === 'user' &&
  !m.parent_tool_use_id &&
  !hasToolResult(m) &&
  !m.isMeta &&
  !m.isSidechain &&
  !m.isCompactSummary

function deriveTurns(msgs) {
  const turns = []
  msgs.forEach((m, i) => {
    if (isPrompt(m))
      turns.push({ at: i, text: textOf(m), anchor: null, anchorAt: -1, sub: 0, assistants: 0 })
    else if (m.type === 'assistant' && turns.length) {
      const t = turns[turns.length - 1]
      if (m.parent_tool_use_id) t.sub++
      else {
        t.anchor = m.uuid
        t.anchorAt = i
        t.assistants++
      }
    }
  })
  return turns
}
const norm = (t) => t.replace(/\s+/g, ' ').trim()
const short = (u) => u?.slice(0, 8) ?? 'none'

const msgs = await getSessionMessages(sessionId, { dir })
const turns = deriveTurns(msgs)
const kinds = msgs.reduce((a, m) => {
  const c = m.message?.content
  const k = `${m.type}:${typeof c === 'string' ? 'str' : Array.isArray(c) ? [...new Set(c.map((b) => b?.type))].join('+') : '?'}${m.parent_tool_use_id ? ':sub' : ''}`
  a[k] = (a[k] || 0) + 1
  return a
}, {})
console.log(`session ${short(sessionId)}  messages=${msgs.length}  turns derived=${turns.length}`)
console.log('message kinds:', JSON.stringify(kinds))
turns.forEach((t, i) =>
  console.log(
    `  turn ${i + 1}: anchor=${short(t.anchor)} (msg #${t.anchorAt}) assistants=${t.assistants} subagentMsgs=${t.sub}  ${JSON.stringify(norm(t.text).slice(0, 60))}`
  )
)
if (flag('--dump'))
  msgs.forEach((m, i) =>
    console.log(
      i,
      m.type.padEnd(9),
      short(m.uuid),
      m.parent_tool_use_id ? 'SUB' : '   ',
      JSON.stringify(textOf(m).slice(0, 50))
    )
  )

let pass = true
if (truth.length) {
  const okAll =
    truth.length === turns.length && truth.every((p, i) => turns[i]?.anchor?.startsWith(p))
  pass &&= okAll
  console.log(
    `TRUTH: stream-observed anchors ${truth.join(',')}  ->  ${okAll ? 'MATCH' : 'MISMATCH'}`
  )
}

if (flag('--fork')) {
  for (let k = 0; k < turns.length; k++) {
    const { anchor, anchorAt } = turns[k]
    const forked = await forkSession(sessionId, { upToMessageId: anchor, dir })
    try {
      const fm = await getSessionMessages(forked.sessionId, { dir })
      const ft = deriveTurns(fm)
      const lenOk = fm.length === anchorAt + 1 // inclusive slice
      const countOk = ft.length === k + 1
      const textsOk = ft.every((t, i) => norm(t.text) === norm(turns[i].text))
      const lastTextOk = textOf(fm[fm.length - 1]) === textOf(msgs[anchorAt])
      const remapped = ft.every((t, i) => t.anchor !== turns[i].anchor)
      const ok = lenOk && countOk && textsOk && lastTextOk
      pass &&= ok
      console.log(
        `FORK@turn${k + 1}: msgs ${fm.length}/${anchorAt + 1}${lenOk ? '' : ' ✗'} turns ${ft.length}/${k + 1}${countOk ? '' : ' ✗'} texts ${textsOk ? 'same' : 'DIFF'} lastMsg ${lastTextOk ? 'same' : 'DIFF'} uuids-remapped=${remapped} fork-anchors=[${ft.map((t) => short(t.anchor)).join(',')}] ${ok ? 'OK' : 'FAIL'}`
      )
    } finally {
      await deleteSession(forked.sessionId, { dir }).catch((e) =>
        console.log('cleanup failed:', e.message)
      )
    }
  }
}
console.log(pass ? 'PROBE: PASS' : 'PROBE: FAIL')
