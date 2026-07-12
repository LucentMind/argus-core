import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CHECKSUMS_FILE = 'CHECKSUMS'

/** Reject absolute paths and any '..' segment (zip-slip / traversal guard). */
function isSafeRel(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel)) return false
  return !rel.split('/').some((seg) => seg === '..' || seg === '')
}

function walkFiles(root: string, rel = ''): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) out.push(...walkFiles(root, childRel))
    else if (ent.isFile()) out.push(childRel)
  }
  return out
}

function parseChecksums(text: string): { map: Map<string, string>; errors: string[] } {
  const map = new Map<string, string>()
  const errors: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const idx = line.indexOf('  ')
    if (idx < 0) {
      errors.push(`malformed CHECKSUMS line: ${line}`)
      continue
    }
    const hex = line.slice(0, idx)
    const rel = line.slice(idx + 2)
    if (!/^[0-9a-f]{64}$/.test(hex) || !isSafeRel(rel)) {
      errors.push(`malformed CHECKSUMS entry for: ${rel || '(empty)'}`)
      continue
    }
    map.set(rel, hex)
  }
  return { map, errors }
}

export function verifyBundleChecksums(dir: string): { ok: boolean; errors: string[] } {
  const checksumsPath = path.join(dir, CHECKSUMS_FILE)
  if (!fs.existsSync(checksumsPath)) return { ok: false, errors: [`missing ${CHECKSUMS_FILE}`] }

  const { map, errors } = parseChecksums(fs.readFileSync(checksumsPath, 'utf8'))
  const present = new Set(walkFiles(dir).filter((r) => r !== CHECKSUMS_FILE))

  for (const rel of present) {
    const expected = map.get(rel)
    if (!expected) {
      errors.push(`file not listed in CHECKSUMS: ${rel}`)
      continue
    }
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(dir, ...rel.split('/'))))
      .digest('hex')
    if (actual !== expected) errors.push(`checksum mismatch: ${rel}`)
  }
  for (const rel of map.keys()) {
    if (!present.has(rel)) errors.push(`file listed in CHECKSUMS is missing: ${rel}`)
  }

  return { ok: errors.length === 0, errors }
}
