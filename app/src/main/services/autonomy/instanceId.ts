import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { instanceIdPath } from '../paths'

/** Returns this install's stable random id, minting it on first use. Corrupt file ⇒ remint
 *  (the id is an identity label, not a key — losing it only splits server-side history). */
export function ensureInstanceId(argusHome: string): string {
  const file = instanceIdPath(argusHome)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: string }
    if (typeof raw.id === 'string' && raw.id.length >= 8) return raw.id
  } catch {
    /* absent or corrupt — mint below */
  }
  const id = crypto.randomUUID()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ id }))
  return id
}
