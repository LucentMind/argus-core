// Scenario 3: shell command permission request.
// Captures PermissionRequestShell (fullCommandText, commands[], possiblePaths,
// possibleUrls, hasWriteFileRedirection, canOfferSessionApproval, warning) so
// the risk taxonomy can key off these fields. Approves a benign echo, denies
// anything else.
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('03-shell-permission')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      onPermissionRequest: sandboxGuard(rec, (request) => {
        if (request?.kind === 'shell') {
          const text = String(request.fullCommandText || '')
          if (/echo/i.test(text) && !/rm |del |Remove-Item/i.test(text)) return { kind: 'approve-once' }
          return { kind: 'reject', feedback: 'only a benign echo is allowed' }
        }
        return { kind: 'reject', feedback: 'shell scenario: only shell approved' }
      })
    })
    rec('meta', { sessionId: session.sessionId })
    wireAllEvents(session, rec)
    const final = await session.sendAndWait(
      'Run a shell command that prints the text hi to stdout. Use echo. Do not create any files.',
      120000
    )
    rec('result', { finalContent: final?.data?.content })
    await session.disconnect()
  })
  await stop(client)
}
