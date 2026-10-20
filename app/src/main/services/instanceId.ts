import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { configDir } from './paths'

/** Per-install random id for vendor-neutral telemetry (spec §4.9). Same file and shape the
 *  autonomy-ledger branch chose, so the two reconcile to one file when both land. */
export function readOrCreateInstanceId(argusHome: string): string {
  const file = path.join(configDir(argusHome), 'instance-id.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { instanceId?: unknown }
    if (typeof parsed.instanceId === 'string' && parsed.instanceId) return parsed.instanceId
  } catch {
    /* absent or corrupt → recreate */
  }
  const instanceId = randomUUID()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ instanceId, createdAt: new Date().toISOString() }, null, 2)
  )
  return instanceId
}
