// Scenario 9: model catalog + the "auto"-only question.
// Captures listModels() verbatim (full ModelInfo objects), auth status, and CLI
// status. Then probes whether the catalog widens: (a) a second listModels()
// call (cache behavior), (b) listing again AFTER a session exists, and
// (c) the session-scoped model list via session.rpc.models.list, if present.
import { newClient, recorder, sandboxDir, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('09-models')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    rec('meta', { auth: await client.getAuthStatus(), status: await client.getStatus() })

    const models1 = await client.listModels()
    rec('result', { phase: 'listModels-1', count: models1.length, models: models1 })

    const models2 = await client.listModels()
    rec('result', { phase: 'listModels-2-cached', count: models2.length, ids: models2.map((m) => m.id) })

    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'models scenario' })
    })
    rec('meta', { sessionId: session.sessionId })

    const models3 = await client.listModels()
    rec('result', { phase: 'listModels-3-after-session', count: models3.length, ids: models3.map((m) => m.id) })

    // Session-scoped model list (may expose more than the connection-level call).
    await guarded(rec, 'session-models', async () => {
      const sessionModels = await session.rpc?.models?.list?.({})
      rec('result', { phase: 'session.rpc.models.list', sessionModels })
    })

    await session.disconnect()
  })
  await stop(client)
}
