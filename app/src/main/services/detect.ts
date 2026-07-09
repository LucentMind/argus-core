import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactType } from '../../shared/types'

const APPLOG_LINE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+[VDIWEF]\s/m

function readHead(filePath: string, bytes = 8192): Buffer {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

export function detectArtifactType(filePath: string): ArtifactType {
  const name = path.basename(filePath).toLowerCase()
  const head = readHead(filePath)

  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return name.endsWith('.rec.gz') ? 'archive-rec' : 'archive'
  }
  if (head.subarray(0, 4).equals(Buffer.from('BINLOG\x01', 'latin1')) || name.endsWith('.binlog')) {
    return 'binlog'
  }
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'archive'
  if (head.length > 262 && head.subarray(257, 262).equals(Buffer.from('ustar', 'latin1')))
    return 'archive'
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'screenshot'
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'screenshot'
  if (name.endsWith('.bintrace') || name.endsWith('.bintrace.zip')) return 'bintrace'

  if (name.endsWith('.list.json')) return 'list-json'
  if (name.endsWith('.json')) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        if (name.includes('tagged') || 'tagged' in parsed || 'tagged_events' in parsed) {
          return 'tagged-json'
        }
        if (Array.isArray(parsed.events)) return 'list-json'
      }
    } catch {
      /* fall through to text probe */
    }
  }

  if (!head.includes(0)) {
    const text = head.toString('utf8')
    if (APPLOG_LINE.test(text) || text.includes('--------- beginning of')) return 'applog'
    return 'text'
  }
  return 'unknown'
}
