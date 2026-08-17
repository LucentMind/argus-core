import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { DistillWorld } from '../../../../shared/distill'
import {
  DISTILL_MAX_ITERATIONS,
  DISTILL_AGENT_TIMEOUT_MS,
  DISTILL_TOOL_DESCRIPTORS,
  DISTILL_ALLOWED_TOOLS,
  listSessionsTool,
  readTranscript,
  searchTranscript
} from '../worldTools'

function world(): DistillWorld {
  return {
    sessions: [
      {
        id: 1,
        title: 'first session',
        messages: [
          { role: 'user', content: 'question one about the flaky test' },
          { role: 'assistant', content: 'answer one' },
          { role: 'tool', content: 'tool output one' },
          { role: 'user', content: 'follow up question' }
        ]
      },
      {
        id: 2,
        title: 'second session',
        messages: [{ role: 'user', content: 'a totally unrelated question' }],
        droppedMessages: 3
      }
    ]
  }
}

describe('module purity', () => {
  it('has no node:sqlite import anywhere in worldTools.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../worldTools.ts'), 'utf8')
    expect(src).not.toContain('node:sqlite')
  })
})

describe('constants', () => {
  it('exposes the fixed iteration/timeout caps', () => {
    expect(DISTILL_MAX_ITERATIONS).toBe(50)
    expect(DISTILL_AGENT_TIMEOUT_MS).toBe(1_800_000)
  })

  it('DISTILL_TOOL_DESCRIPTORS carries the exact hashed description text', () => {
    const byName = Object.fromEntries(DISTILL_TOOL_DESCRIPTORS.map((d) => [d.name, d]))
    expect(byName.list_sessions.description).toBe(
      "List this case's chat sessions with message counts. Snapshot-served: reflects the case as of distill enqueue."
    )
    expect(byName.read_transcript.description).toBe(
      "Read a slice of one session's transcript (offset/limit, optional roles filter: user|assistant|tool). Use after user messages reference work you must see."
    )
    expect(byName.search_transcript.description).toBe(
      'Case-insensitive substring search across all snapshot transcripts. Returns session/position/excerpt hits.'
    )
    expect(byName.run_tool_script.description).toBe(
      "Run a Node script calling list_sessions/read_transcript/search_transcript via require('./argus_tools') for whole-case sweeps; only stdout returns to you."
    )
    // byte-check: real U+2026 ellipsis is absent here (none of these strings use one), and
    // no U+FFFD replacement char crept in anywhere in the descriptor text.
    for (const d of DISTILL_TOOL_DESCRIPTORS) {
      expect(d.description.includes('�')).toBe(false)
    }
  })

  it('DISTILL_ALLOWED_TOOLS lists the mcp__argus__-prefixed tool names', () => {
    expect(DISTILL_ALLOWED_TOOLS).toEqual([
      'mcp__argus__list_sessions',
      'mcp__argus__read_transcript',
      'mcp__argus__search_transcript',
      'mcp__argus__run_tool_script'
    ])
  })
})

describe('listSessionsTool', () => {
  it('reports id/title/messageCount/droppedMessages per session', () => {
    expect(listSessionsTool(world())).toEqual([
      { id: 1, title: 'first session', messageCount: 4, droppedMessages: 0 },
      { id: 2, title: 'second session', messageCount: 1, droppedMessages: 3 }
    ])
  })

  it('returns an empty list for an empty world', () => {
    expect(listSessionsTool({ sessions: [] })).toEqual([])
  })
})

describe('readTranscript', () => {
  it('defaults to offset 0, limit 50', () => {
    const res = readTranscript(world(), { session_id: 1 })
    expect(res.offset).toBe(0)
    expect(res.total).toBe(4)
    expect(res.messages).toEqual([
      { role: 'user', content: 'question one about the flaky test' },
      { role: 'assistant', content: 'answer one' },
      { role: 'tool', content: 'tool output one' },
      { role: 'user', content: 'follow up question' }
    ])
  })

  it('pages with explicit offset/limit', () => {
    const res = readTranscript(world(), { session_id: 1, offset: 1, limit: 2 })
    expect(res.offset).toBe(1)
    expect(res.total).toBe(4)
    expect(res.messages).toEqual([
      { role: 'assistant', content: 'answer one' },
      { role: 'tool', content: 'tool output one' }
    ])
  })

  it('filters by roles, and total reflects the filtered count', () => {
    const res = readTranscript(world(), { session_id: 1, roles: ['user'] })
    expect(res.total).toBe(2)
    expect(res.messages).toEqual([
      { role: 'user', content: 'question one about the flaky test' },
      { role: 'user', content: 'follow up question' }
    ])
  })

  it('carries the elision note for a session with droppedMessages', () => {
    const res = readTranscript(world(), { session_id: 2 })
    expect(res.note).toBe('… earlier messages elided at snapshot time')
  })

  it('omits the note for a session with no droppedMessages', () => {
    const res = readTranscript(world(), { session_id: 1 })
    expect(res.note).toBeUndefined()
  })

  it('returns an empty page for an unknown session id', () => {
    const res = readTranscript(world(), { session_id: 999 })
    expect(res).toEqual({ messages: [], total: 0, offset: 0 })
  })
})

describe('searchTranscript', () => {
  it('is case-insensitive and returns ±120-char excerpts around the match', () => {
    const w: DistillWorld = {
      sessions: [
        {
          id: 1,
          title: 's1',
          messages: [{ role: 'assistant', content: 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200) }]
        }
      ]
    }
    const res = searchTranscript(w, { query: 'needle' })
    expect(res.hits).toHaveLength(1)
    const hit = res.hits[0]
    expect(hit.sessionId).toBe(1)
    expect(hit.index).toBe(0)
    expect(hit.role).toBe('assistant')
    expect(hit.excerpt).toBe('x'.repeat(120) + 'NEEDLE' + 'y'.repeat(120))
  })

  it('finds hits across sessions and reports the message index within its session', () => {
    const res = searchTranscript(world(), { query: 'question' })
    expect(res.hits).toEqual([
      { sessionId: 1, index: 0, role: 'user', excerpt: 'question one about the flaky test' },
      { sessionId: 1, index: 3, role: 'user', excerpt: 'follow up question' },
      { sessionId: 2, index: 0, role: 'user', excerpt: 'a totally unrelated question' }
    ])
  })

  it('filters by roles', () => {
    const res = searchTranscript(world(), { query: 'one', roles: ['assistant'] })
    expect(res.hits).toEqual([{ sessionId: 1, index: 1, role: 'assistant', excerpt: 'answer one' }])
  })

  it('returns no hits when nothing matches', () => {
    expect(searchTranscript(world(), { query: 'nonexistent-xyz' }).hits).toEqual([])
  })
})

describe('determinism', () => {
  it('two calls with identical args on the same world return byte-identical JSON', () => {
    const w = world()
    const a1 = JSON.stringify(readTranscript(w, { session_id: 1 }))
    const a2 = JSON.stringify(readTranscript(w, { session_id: 1 }))
    expect(a1).toBe(a2)

    const b1 = JSON.stringify(searchTranscript(w, { query: 'question' }))
    const b2 = JSON.stringify(searchTranscript(w, { query: 'question' }))
    expect(b1).toBe(b2)

    const c1 = JSON.stringify(listSessionsTool(w))
    const c2 = JSON.stringify(listSessionsTool(w))
    expect(c1).toBe(c2)
  })
})
