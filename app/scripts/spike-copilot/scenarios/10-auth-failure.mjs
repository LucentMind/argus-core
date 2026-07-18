// Scenario 10: authentication failure shape.
// Boots a SECOND, isolated client against a fresh empty COPILOT_HOME with
// useLoggedInUser:false and every GitHub token env var stripped, so it cannot
// authenticate. Captures getAuthStatus() (the typed unauth shape) and the error
// thrown when a turn is attempted. Never touches the real user's auth/home.
import fs from 'node:fs'
import path from 'node:path'
import { newClient, recorder, wireAllEvents, sandboxDir, stop, guarded, HERE } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('10-auth-failure')
  const noAuthHome = path.join(HERE, '.copilot-home-noauth')
  fs.rmSync(noAuthHome, { recursive: true, force: true })
  fs.mkdirSync(noAuthHome, { recursive: true })

  const strippedEnv = {
    ...process.env,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    COPILOT_GITHUB_TOKEN: undefined,
    GH_COPILOT_TOKEN: undefined,
    GITHUB_COPILOT_TOKEN: undefined,
    GITHUB_OAUTH_TOKEN: undefined
  }

  const client = newClient({ baseDirectory: noAuthHome, useLoggedInUser: false, env: strippedEnv })
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const auth = await client.getAuthStatus()
    rec('result', { phase: 'auth-status', auth })
    // Attempt a session + turn to capture the typed failure surface. The
    // unauth turn error surfaces via an unhandled async rejection AND/OR a
    // session.error event rather than (only) the awaited sendAndWait, so we
    // trap both channels here — the surfacing path is itself evidence.
    await guarded(rec, 'create-session-unauth', async () => {
      const session = await client.createSession({
        workingDirectory: sandboxDir(),
        onPermissionRequest: () => ({ kind: 'reject', feedback: 'noauth' })
      })
      rec('meta', { phase: 'session-created-despite-unauth', sessionId: session.sessionId })
      wireAllEvents(session, rec)

      const trap = (err) => rec('error', { phase: 'unhandled-rejection', channel: 'process', message: String(err?.message ?? err), name: err?.name })
      process.on('unhandledRejection', trap)
      process.on('uncaughtException', trap)
      await guarded(rec, 'send-unauth', async () => {
        const final = await session.sendAndWait('Reply with exactly: OK', 30000)
        rec('result', { phase: 'send-result', finalContent: final?.data?.content })
      })
      // Give the async rejection / session.error a moment to land in the fixture.
      await new Promise((r) => setTimeout(r, 1500))
      process.off('unhandledRejection', trap)
      process.off('uncaughtException', trap)
      await guarded(rec, 'disconnect', async () => session.disconnect())
    })
  })
  await stop(client)
  // Best-effort scratch cleanup; the runtime may still hold a Windows file lock
  // on session-store.db for a moment after forceStop. The dir is gitignored.
  await new Promise((r) => setTimeout(r, 500))
  try {
    fs.rmSync(noAuthHome, { recursive: true, force: true })
  } catch {
    /* ignore transient EBUSY on Windows; scratch dir is gitignored */
  }
}
