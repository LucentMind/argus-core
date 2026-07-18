// Phase-2 spike, step 0: can we boot the bundled runtime and authenticate?
import { CopilotClient } from '@github/copilot-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = path.join(here, '.copilot-home')
fs.mkdirSync(scratch, { recursive: true })

const client = new CopilotClient({
  baseDirectory: scratch,
  logLevel: 'error'
})

try {
  const started = Date.now()
  await client.start()
  const auth = await client.getAuthStatus()
  const models = auth?.isAuthenticated ? await client.listModels() : null
  console.log(
    JSON.stringify(
      { ok: true, ms: Date.now() - started, auth, modelCount: models?.length ?? null, firstModels: models?.slice(0, 6) },
      null,
      1
    )
  )
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }, null, 1))
} finally {
  await client.forceStop?.().catch(() => {})
  process.exit(0)
}
