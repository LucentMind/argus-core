import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { DistillWorld } from '../../../shared/distill'
import {
  runToolScript,
  PTC_DISTILL_MAX_CALLS,
  PTC_DISTILL_STDOUT_CAP,
  PTC_DISTILL_TIMEOUT_MS
} from '../ptc/run'
import {
  listSessionsTool,
  readTranscript,
  searchTranscript,
  DISTILL_TOOL_DESCRIPTORS
} from './worldTools'

const descByName = Object.fromEntries(DISTILL_TOOL_DESCRIPTORS.map((d) => [d.name, d.description]))

/** Zod param shapes, named so `createDistillMcpServer`'s `tool(...)` calls and the exported
 *  schema map below share exactly one definition each — never two copies that could drift. */
const listSessionsSchema = {}
const readTranscriptSchema = {
  session_id: z.number(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  roles: z.array(z.string()).optional()
}
const searchTranscriptSchema = { query: z.string(), roles: z.array(z.string()).optional() }
const runToolScriptSchema = { script: z.string() }

/** Tool name -> zod param shape, for `DISTILL_TOOL_DESCRIPTORS`' `params` arrays (worldTools.ts)
 *  to be tested against — the descriptor list and the zod schemas are two representations of
 *  the same prompt-facing tool surface, and nothing else pins them together. */
export const DISTILL_TOOL_SCHEMAS: Record<string, Record<string, z.ZodTypeAny>> = {
  list_sessions: listSessionsSchema,
  read_transcript: readTranscriptSchema,
  search_transcript: searchTranscriptSchema,
  run_tool_script: runToolScriptSchema
}

/** Tools callable from inside a distiller `run_tool_script` script via `require('./argus_tools')` --
 *  unprefixed names, matching the PTC wire protocol (server.ts's allowlist check, stub.ts's wrappers). */
const PTC_DISTILL_TOOLS = ['list_sessions', 'read_transcript', 'search_transcript'] as const

function asText(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] }
}

export interface PtcDistillCaps {
  maxCalls: number
  stdoutCapBytes: number
  timeoutMs: number
}

export interface DistillMcpHooks {
  /** Fired at the top of every TOP-LEVEL tool handler (not for a script's own sub-calls): the
   *  progress line's only per-turn signal inside the agentic stage. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void
}

/** One line for the progress readout: `read_transcript s1`, `search_transcript "…"`. Never the
 *  script body — a script is a program, not a label. */
export function toolCallSummary(name: string, args: Record<string, unknown>): string {
  if (name === 'read_transcript' && typeof args.session_id === 'number')
    return `read_transcript s${args.session_id}`
  if (name === 'search_transcript' && typeof args.query === 'string') {
    const q = args.query
    return `search_transcript "${q.length > 40 ? q.slice(0, 40) + '…' : q}"`
  }
  return name
}

/** mirrors createArgusMcpServer (nativeTools.ts) -- same createSdkMcpServer/tool/asText shape,
 *  but every handler reads the SAME frozen `world` snapshot instead of the live DB. */
export function createDistillMcpServer(
  world: DistillWorld,
  ptcDispatchless?: PtcDistillCaps,
  hooks: DistillMcpHooks = {}
): ReturnType<typeof createSdkMcpServer> {
  const caps: PtcDistillCaps = ptcDispatchless ?? {
    maxCalls: PTC_DISTILL_MAX_CALLS,
    stdoutCapBytes: PTC_DISTILL_STDOUT_CAP,
    timeoutMs: PTC_DISTILL_TIMEOUT_MS
  }
  const tick = (name: string, args: Record<string, unknown>): void => hooks.onToolCall?.(name, args)

  const dispatch = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (toolName) {
      case 'list_sessions':
        return listSessionsTool(world)
      case 'read_transcript':
        return readTranscript(world, args as unknown as Parameters<typeof readTranscript>[1])
      case 'search_transcript':
        return searchTranscript(world, args as unknown as Parameters<typeof searchTranscript>[1])
      default:
        throw new Error(`tool "${toolName}" is not allowed in scripts`)
    }
  }

  return createSdkMcpServer({
    name: 'argus',
    version: '1.0.0',
    tools: [
      tool('list_sessions', descByName.list_sessions, listSessionsSchema, async () => {
        tick('list_sessions', {})
        return asText(JSON.stringify(listSessionsTool(world)))
      }),
      tool('read_transcript', descByName.read_transcript, readTranscriptSchema, async (a) => {
        tick('read_transcript', a)
        return asText(JSON.stringify(readTranscript(world, a)))
      }),
      tool('search_transcript', descByName.search_transcript, searchTranscriptSchema, async (a) => {
        tick('search_transcript', a)
        return asText(JSON.stringify(searchTranscript(world, a)))
      }),
      tool('run_tool_script', descByName.run_tool_script, runToolScriptSchema, async (a) => {
        tick('run_tool_script', a)
        const res = await runToolScript({
          script: a.script,
          allowedTools: [...PTC_DISTILL_TOOLS],
          dispatch,
          maxCalls: caps.maxCalls,
          stdoutCapBytes: caps.stdoutCapBytes,
          timeoutMs: caps.timeoutMs
        })
        return asText(
          JSON.stringify(
            {
              stdout: res.stdout,
              stdout_bytes_total: res.stdoutBytesTotal,
              stdout_bytes_omitted: res.stdoutBytesOmitted,
              exit_code: res.exitCode,
              timed_out: res.timedOut,
              tool_calls: res.calls
            },
            null,
            2
          )
        )
      })
    ]
  })
}
