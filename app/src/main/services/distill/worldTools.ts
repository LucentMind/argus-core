import type { DistillWorld, WorldSession } from '../../../shared/distill'

/** Agentic distiller iteration/timeout caps (Task 6/9's outer loop, not the PTC child process). */
export const DISTILL_MAX_ITERATIONS = 50
export const DISTILL_AGENT_TIMEOUT_MS = 1_800_000

const EXCERPT_RADIUS = 120
const DEFAULT_LIMIT = 50

/** Prompt-surface descriptors — Task 9 hashes JSON.stringify(this) + PTC_STUB_VERSION.
 *  Ship these description strings verbatim: they are part of the hashed distill prompt. */
export const DISTILL_TOOL_DESCRIPTORS: { name: string; description: string; params: string[] }[] = [
  {
    name: 'list_sessions',
    description:
      "List this case's chat sessions with message counts. Snapshot-served: reflects the case as of distill enqueue.",
    params: []
  },
  {
    name: 'read_transcript',
    description:
      "Read a slice of one session's transcript (offset/limit, optional roles filter: user|assistant|tool). Use after user messages reference work you must see.",
    params: ['session_id', 'offset', 'limit', 'roles']
  },
  {
    name: 'search_transcript',
    description:
      'Case-insensitive substring search across all snapshot transcripts. Returns session/position/excerpt hits.',
    params: ['query', 'roles']
  },
  {
    name: 'run_tool_script',
    description:
      "Run a Node script calling list_sessions/read_transcript/search_transcript via require('./argus_tools') for whole-case sweeps; only stdout returns to you.",
    params: ['script']
  }
]

export const DISTILL_ALLOWED_TOOLS: string[] = [
  'mcp__argus__list_sessions',
  'mcp__argus__read_transcript',
  'mcp__argus__search_transcript',
  'mcp__argus__run_tool_script'
]

export function listSessionsTool(
  world: DistillWorld
): { id: number; title: string; messageCount: number; droppedMessages: number }[] {
  return world.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    messageCount: s.messages.length,
    droppedMessages: s.droppedMessages ?? 0
  }))
}

function findSession(world: DistillWorld, sessionId: number): WorldSession | undefined {
  return world.sessions.find((s) => s.id === sessionId)
}

export function readTranscript(
  world: DistillWorld,
  a: { session_id: number; offset?: number; limit?: number; roles?: string[] }
): { messages: { role: string; content: string }[]; total: number; offset: number; note?: string } {
  const offset = a.offset ?? 0
  const limit = a.limit ?? DEFAULT_LIMIT
  const session = findSession(world, a.session_id)
  if (!session) return { messages: [], total: 0, offset }

  const filtered = a.roles
    ? session.messages.filter((m) => a.roles!.includes(m.role))
    : session.messages
  const page = filtered
    .slice(offset, offset + limit)
    .map((m) => ({ role: m.role, content: m.content }))

  const result: {
    messages: { role: string; content: string }[]
    total: number
    offset: number
    note?: string
  } = {
    messages: page,
    total: filtered.length,
    offset
  }
  if (session.droppedMessages) result.note = '… earlier messages elided at snapshot time'
  return result
}

export function searchTranscript(
  world: DistillWorld,
  a: { query: string; roles?: string[] }
): { hits: { sessionId: number; index: number; role: string; excerpt: string }[] } {
  const needle = a.query.toLowerCase()
  const hits: { sessionId: number; index: number; role: string; excerpt: string }[] = []
  for (const session of world.sessions) {
    session.messages.forEach((m, index) => {
      if (a.roles && !a.roles.includes(m.role)) return
      const matchAt = m.content.toLowerCase().indexOf(needle)
      if (matchAt === -1) return
      const start = Math.max(0, matchAt - EXCERPT_RADIUS)
      const end = Math.min(m.content.length, matchAt + needle.length + EXCERPT_RADIUS)
      hits.push({
        sessionId: session.id,
        index,
        role: m.role,
        excerpt: m.content.slice(start, end)
      })
    })
  }
  return { hits }
}
