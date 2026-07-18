import { createClaudeDriver, type CreateQueryFn } from '../index'
import { runDriverContractSuite, type TransportScript } from '../../../__tests__/driverContract'

// Claude script entries are raw SDK-shaped messages (the same fixtures Task 3's
// claudeDriver.test.ts uses). The fake query is send-gated: it produces nothing until a
// user prompt arrives on the prompt stream, then enacts one turn per the current script —
// exactly the ordering the contract's invariant 2 pins.
type CanUseTool = (
  name: string,
  input: Record<string, unknown>,
  opts: { signal: AbortSignal }
) => Promise<{ behavior: string }>

function fakeQuery(getScript: () => TransportScript): CreateQueryFn {
  return (args) => {
    const options = args.options as { canUseTool: CanUseTool }
    return {
      async *[Symbol.asyncIterator]() {
        // One turn per user prompt; the contract scripts drive a single turn.
        for await (const _user of args.prompt) {
          void _user
          const script = getScript()
          if (script.throwMidStream) throw new Error('scripted transport failure')
          if (script.checkpoint) {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: script.checkpoint,
              model: 'claude-sonnet-5'
            }
          }
          for (const text of script.content ?? []) {
            yield {
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
            }
          }
          if (script.toolCall) {
            // Route the attempt through the real approval pipeline (invariant 3). A tool
            // result is emitted only on allow, so a deny is observably non-executing.
            const decision = await options.canUseTool(script.toolCall.name, script.toolCall.input, {
              signal: new AbortController().signal
            })
            if (decision.behavior === 'allow') {
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', id: 'tc-1', name: script.toolCall.name }
                }
              }
              yield {
                type: 'user',
                message: {
                  content: [
                    { type: 'tool_result', tool_use_id: 'tc-1', content: 'ran', is_error: false }
                  ]
                }
              }
            }
          }
          if (script.completeTurn) {
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: script.checkpoint,
              usage: { input_tokens: 5, output_tokens: 2 },
              total_cost_usd: 0.001,
              duration_ms: 10
            }
          }
          break
        }
      },
      interrupt: async () => undefined // "ignores" interrupt: never ends the stream itself
    }
  }
}

let currentScript: TransportScript = {}

runDriverContractSuite(
  () => createClaudeDriver(fakeQuery(() => currentScript)),
  (script) => {
    currentScript = script
  }
)
