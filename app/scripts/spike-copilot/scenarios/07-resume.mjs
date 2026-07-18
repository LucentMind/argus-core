// Scenario 7: session resume + cursor/persistence format.
// Creates a session, sends a fact, disconnects, then resumes by id and asks the
// model to recall it — proving history continuity. Captures the sessionId,
// listSessions()/getSessionMetadata() shapes, getEvents() history, and the
// on-disk layout under .copilot-home so we know what a "cursor" actually is.
import fs from 'node:fs'
import path from 'node:path'
import { newClient, recorder, wireAllEvents, sandboxDir, stop, guarded, SCRATCH_HOME } from '../lib.mjs'

function listDirShallow(dir, depth = 2) {
  const out = []
  const walk = (d, level) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      out.push({ path: path.relative(SCRATCH_HOME, full), dir: e.isDirectory() })
      if (e.isDirectory() && level < depth) walk(full, level + 1)
    }
  }
  walk(dir, 0)
  return out
}

export default async function run() {
  const { rec } = recorder('07-resume')
  const client = newClient()
  let sessionId
  await guarded(rec, 'create', async () => {
    await client.start()
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'resume scenario: no tools' })
    })
    sessionId = session.sessionId
    rec('meta', { phase: 'create', sessionId })
    wireAllEvents(session, rec)
    await session.sendAndWait('Remember this word for later: banana. Reply with exactly: OK', 120000)
    rec('meta', { phase: 'afterFirstTurn', sessionStateDir: listDirShallow(path.join(SCRATCH_HOME, 'session-state')) })
    await session.disconnect()
  })

  await guarded(rec, 'resume', async () => {
    const meta = await client.getSessionMetadata(sessionId)
    const list = await client.listSessions()
    rec('meta', { phase: 'metadata', getSessionMetadata: meta, listSessionsCount: list.length, listSessionsSample: list.slice(0, 3) })
    const resumed = await client.resumeSession(sessionId, {
      onPermissionRequest: () => ({ kind: 'reject', feedback: 'resume scenario: no tools' })
    })
    rec('meta', { phase: 'resumed', resumedSessionId: resumed.sessionId, sameId: resumed.sessionId === sessionId })
    wireAllEvents(resumed, rec)
    const history = await resumed.getEvents()
    rec('result', {
      phase: 'history',
      eventCount: history.length,
      eventTypes: history.map((e) => e.type)
    })
    const final = await resumed.sendAndWait('What word did I ask you to remember? Reply with just the word.', 120000)
    rec('result', { phase: 'recall', finalContent: final?.data?.content, continuityProven: /banana/i.test(final?.data?.content || '') })
    await resumed.disconnect()
  })
  await stop(client)
}
