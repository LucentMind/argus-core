// Scenario 11: interrupt mid-turn.
// Starts a longer generation, then calls session.abort() shortly after the
// first streamed delta arrives, and records how the stream terminates
// (the `abort` event, any trailing assistant.message, and session.idle).
import { newClient, recorder, wireAllEvents, sandboxDir, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('11-interrupt')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'interrupt scenario: no tools' })
    })
    rec('meta', { sessionId: session.sessionId })
    wireAllEvents(session, rec)

    let aborted = false
    const abortOnce = async (why) => {
      if (aborted) return
      aborted = true
      rec('meta', { abortTrigger: why })
      await guarded(rec, 'abort-call', async () => {
        await session.abort()
        rec('meta', { abortAcknowledged: true })
      })
    }
    // Abort as soon as generation starts producing tokens.
    session.on('assistant.message_delta', () => {
      void abortOnce('first-delta')
    })
    // Safety net if no deltas arrive.
    const timer = setTimeout(() => void abortOnce('timeout-2s'), 2000)

    await guarded(rec, 'send', async () => {
      const final = await session.sendAndWait(
        'Count slowly from 1 to 200, writing each number on its own line with a short comment.',
        120000
      )
      rec('result', { finalContent: final?.data?.content?.slice(0, 200), truncatedForFixture: true })
    })
    clearTimeout(timer)
    // Give trailing events a moment to flush into the fixture.
    await new Promise((r) => setTimeout(r, 1500))
    await session.disconnect()
  })
  await stop(client)
}
