// Scenario 1: plain streamed chat turn.
// Captures delta events, the final assistant.message, assistant.usage, and
// session.idle so we can map the streaming event lifecycle → AgentEvent types.
import { newClient, recorder, wireAllEvents, sandboxDir, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('01-chat')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    rec('meta', { status: await client.getStatus(), auth: await client.getAuthStatus() })
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'chat scenario: no tools expected' })
    })
    rec('meta', { sessionId: session.sessionId, capabilities: session.capabilities })
    wireAllEvents(session, rec)
    const final = await session.sendAndWait('Reply with exactly: OK', 120000)
    rec('result', { finalContent: final?.data?.content, finalType: final?.type })
    await session.disconnect()
  })
  await stop(client)
}
