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

/** mirrors createArgusMcpServer (nativeTools.ts) -- same createSdkMcpServer/tool/asText shape,
 *  but every handler reads the SAME frozen `world` snapshot instead of the live DB. */
export function createDistillMcpServer(
  world: DistillWorld,
  ptcDispatchless?: PtcDistillCaps
): ReturnType<typeof createSdkMcpServer> {
  const caps: PtcDistillCaps = ptcDispatchless ?? {
    maxCalls: PTC_DISTILL_MAX_CALLS,
    stdoutCapBytes: PTC_DISTILL_STDOUT_CAP,
    timeoutMs: PTC_DISTILL_TIMEOUT_MS
  }

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
      tool('list_sessions', descByName.list_sessions, {}, async () =>
        asText(JSON.stringify(listSessionsTool(world)))
      ),
      tool(
        'read_transcript',
        descByName.read_transcript,
        {
          session_id: z.number(),
          offset: z.number().optional(),
          limit: z.number().optional(),
          roles: z.array(z.string()).optional()
        },
        async (a) => asText(JSON.stringify(readTranscript(world, a)))
      ),
      tool(
        'search_transcript',
        descByName.search_transcript,
        { query: z.string(), roles: z.array(z.string()).optional() },
        async (a) => asText(JSON.stringify(searchTranscript(world, a)))
      ),
      tool('run_tool_script', descByName.run_tool_script, { script: z.string() }, async (a) => {
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
