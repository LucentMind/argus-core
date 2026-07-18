// Scenario 4: read/view + network/fetch tool calls (taxonomy).
// Run A: read an in-sandbox file — capture PermissionRequestRead (or observe
//        that reads are auto-allowed without a prompt).
// Run B: ask for a URL fetch — capture PermissionRequestUrl and DENY it, so no
//        real network egress happens; the deny path + request shape are the
//        evidence for the URL risk class.
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('04-read-fetch')

  // Run A — read.
  {
    const client = newClient()
    await guarded(rec, 'runA-read', async () => {
      await client.start()
      const session = await client.createSession({
        workingDirectory: sandboxDir(),
        streaming: true,
        onPermissionRequest: sandboxGuard(rec, (request) => {
          if (request?.kind === 'read') return { kind: 'approve-once' }
          return { kind: 'reject', feedback: 'read scenario: only read approved' }
        })
      })
      rec('meta', { label: 'runA-read', sessionId: session.sessionId })
      wireAllEvents(session, rec)
      const final = await session.sendAndWait(
        'Read the file notes.txt in the current directory and tell me only its first line.',
        120000
      )
      rec('result', { label: 'runA-read', finalContent: final?.data?.content })
      await session.disconnect()
    })
    await stop(client)
  }

  // Run B — url/fetch (denied, no egress).
  {
    const client = newClient()
    await guarded(rec, 'runB-url', async () => {
      await client.start()
      const session = await client.createSession({
        workingDirectory: sandboxDir(),
        streaming: true,
        onPermissionRequest: sandboxGuard(rec, (request) => {
          if (request?.kind === 'url') return { kind: 'reject', feedback: 'no network egress in spike' }
          if (request?.kind === 'read') return { kind: 'approve-once' }
          return { kind: 'reject', feedback: 'url scenario' }
        })
      })
      rec('meta', { label: 'runB-url', sessionId: session.sessionId })
      wireAllEvents(session, rec)
      const final = await session.sendAndWait(
        'Fetch the contents of the URL https://example.com and summarize the first sentence.',
        120000
      )
      rec('result', { label: 'runB-url', finalContent: final?.data?.content })
      await session.disconnect()
    })
    await stop(client)
  }
}
