// Bonus (cheap, no model turns): ping(), getStatus(), getAuthStatus(),
// listSessions() metadata, getLastSessionId(), and the session capabilities
// object. These feed the Argus probe/health surface and driver capability map.
import { newClient, recorder, sandboxDir, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('99-bonus')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    rec('result', { phase: 'ping', ping: await client.ping('spike-health') })
    rec('result', { phase: 'status', status: await client.getStatus() })
    rec('result', { phase: 'auth', auth: await client.getAuthStatus() })

    const sessions = await client.listSessions()
    rec('result', {
      phase: 'listSessions',
      count: sessions.length,
      sample: sessions.slice(0, 3)
    })
    await guarded(rec, 'lastSessionId', async () => {
      rec('result', { phase: 'getLastSessionId', lastSessionId: await client.getLastSessionId() })
    })

    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'bonus scenario: no tools' })
    })
    rec('result', {
      phase: 'session-capabilities',
      sessionId: session.sessionId,
      capabilities: session.capabilities,
      workspacePath: session.workspacePath
    })
    await session.disconnect()
  })
  await stop(client)
}
