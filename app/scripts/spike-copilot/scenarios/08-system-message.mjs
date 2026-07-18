// Scenario 8: system message injection (persona) via SystemMessageAppendConfig.
// Appends an instruction to end every reply with a sentinel token and verifies
// the token appears in the output — proving the append channel Argus would use
// for persona/skill injection actually reaches the model.
import { newClient, recorder, wireAllEvents, sandboxDir, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('08-system-message')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const sentinel = 'ZZQ-9137'
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      systemMessage: { mode: 'append', content: `IMPORTANT: You must end every single reply with the exact token ${sentinel} on its own line.` },
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'system-message scenario: no tools' })
    })
    rec('meta', { sessionId: session.sessionId, systemMessageMode: 'append', sentinel })
    wireAllEvents(session, rec)
    const final = await session.sendAndWait('Say hello in one short sentence.', 120000)
    const content = final?.data?.content || ''
    rec('result', { finalContent: content, personaApplied: content.includes(sentinel) })
    await session.disconnect()
  })
  await stop(client)
}
