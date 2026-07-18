// Scenario 2: file-write permission request + the "editable approvals" question.
// Run A: approve normally, capture the full PermissionRequestWrite shape.
// Run B: on approve, ALSO return extra fields that would carry modified input
//        (newFileContents / updatedInput / modifiedArgs). Then read the file
//        back to prove empirically whether the runtime honored any of them.
import fs from 'node:fs'
import path from 'node:path'
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded } from '../lib.mjs'

async function oneRun(rec, label, fileName, decisionFor) {
  const client = newClient()
  await guarded(rec, label, async () => {
    await client.start()
    const sandbox = sandboxDir()
    const target = path.join(sandbox, fileName)
    if (fs.existsSync(target)) fs.rmSync(target)
    const session = await client.createSession({
      workingDirectory: sandbox,
      streaming: true,
      onPermissionRequest: sandboxGuard(rec, (request) => decisionFor(request, fileName))
    })
    rec('meta', { label, sessionId: session.sessionId })
    wireAllEvents(session, rec)
    const final = await session.sendAndWait(
      `Create a file named ${fileName} in the current directory containing exactly the text: hi`,
      120000
    )
    rec('result', {
      label,
      finalContent: final?.data?.content,
      fileExists: fs.existsSync(target),
      fileContents: fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null
    })
    await session.disconnect()
  })
  await stop(client)
}

export default async function run() {
  const { rec } = recorder('02-write-permission')

  // Run A — plain approve-once for the expected write.
  await oneRun(rec, 'runA-approve', 'hello.txt', (request, fileName) =>
    request?.kind === 'write' && String(request.fileName || '').endsWith(fileName)
      ? { kind: 'approve-once' }
      : { kind: 'reject', feedback: 'only the expected write is allowed' }
  )

  // Run B — approve BUT attempt to smuggle modified input via extra fields.
  await oneRun(rec, 'runB-modified-input', 'hello2.txt', (request, fileName) => {
    if (request?.kind === 'write' && String(request.fileName || '').endsWith(fileName)) {
      // The PermissionDecision union has NO field for edited input; these extra
      // keys are the experiment. If the file ends up containing MODIFIED_BY_HOST
      // instead of "hi", the SDK honored one of them.
      return {
        kind: 'approve-once',
        newFileContents: 'MODIFIED_BY_HOST',
        updatedInput: { content: 'MODIFIED_BY_HOST' },
        modifiedArgs: { content: 'MODIFIED_BY_HOST' }
      }
    }
    return { kind: 'reject', feedback: 'only the expected write is allowed' }
  })
}
