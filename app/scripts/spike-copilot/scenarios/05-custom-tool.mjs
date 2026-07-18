// Scenario 5: custom (native) tool registration via SessionConfig.tools.
// Registers `argus_echo`, prompts the agent to call it, and captures:
//   - the handler invocation envelope (args + ToolInvocation metadata),
//   - the PermissionRequestCustomTool shape,
//   - the tool.execution_start / tool.execution_complete events.
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('05-custom-tool')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const argusEcho = {
      name: 'argus_echo',
      description: 'Echoes back the provided text verbatim. Use this when asked to echo.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to echo' } },
        required: ['text']
      },
      handler: async (args, invocation) => {
        rec('tool-invocation', { args, invocation })
        return `echo:${args?.text}`
      }
    }
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      tools: [argusEcho],
      onPermissionRequest: sandboxGuard(rec, (request) => {
        if (request?.kind === 'custom-tool' && request.toolName === 'argus_echo') return { kind: 'approve-once' }
        return { kind: 'reject', feedback: 'only argus_echo approved' }
      })
    })
    rec('meta', { sessionId: session.sessionId })
    wireAllEvents(session, rec)
    const final = await session.sendAndWait(
      "Call the argus_echo tool with text set to 'hello-argus' and then report exactly what it returned.",
      120000
    )
    rec('result', { finalContent: final?.data?.content })
    await session.disconnect()
  })
  await stop(client)
}
