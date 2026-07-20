import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestBytes } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import type { DatabaseSync } from 'node:sqlite'

// 1x1 transparent PNG — real magic bytes so detection types it as `screenshot`
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

let home: string
let db: DatabaseSync
const detection = createDetection(samplePackRegistry())

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bytes-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAVAPI-1', title: 'test' })
})

describe('ingestBytes', () => {
  it('writes the bytes to disk and records origin paste', () => {
    const { record, deduped } = ingestBytes(
      db,
      home,
      detection,
      'NAVAPI-1',
      'screenshot-2026-07-20-143052.png',
      PNG,
      'paste'
    )
    expect(deduped).toBe(false)
    expect(record.relPath).toBe('evidence/screenshot-2026-07-20-143052.png')
    expect(record.origin).toBe('paste')
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/)
    const onDisk = path.join(home, 'cases/NAVAPI-1', record.relPath)
    expect(fs.readFileSync(onDisk).equals(PNG)).toBe(true)
  })

  it('returns the existing record for identical bytes and writes no second file', () => {
    const first = ingestBytes(db, home, detection, 'NAVAPI-1', 'a.png', PNG, 'paste')
    const second = ingestBytes(db, home, detection, 'NAVAPI-1', 'b.png', PNG, 'paste')
    expect(second.deduped).toBe(true)
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.relPath).toBe('evidence/a.png')
    const files = fs.readdirSync(path.join(home, 'cases/NAVAPI-1/evidence'))
    expect(files.filter((f) => f.endsWith('.png'))).toEqual(['a.png'])
  })

  it('suffixes a colliding filename when the bytes differ', () => {
    const other = Buffer.concat([PNG, Buffer.from([0x00])])
    const a = ingestBytes(db, home, detection, 'NAVAPI-1', 'shot.png', PNG, 'paste')
    const b = ingestBytes(db, home, detection, 'NAVAPI-1', 'shot.png', other, 'paste')
    expect(a.record.relPath).toBe('evidence/shot.png')
    expect(b.record.relPath).toBe('evidence/shot-1.png')
    expect(b.deduped).toBe(false)
  })

  it('dedupes per case, not globally', () => {
    createCase(db, home, { slug: 'NAVAPI-2', title: 'other' })
    ingestBytes(db, home, detection, 'NAVAPI-1', 'shot.png', PNG, 'paste')
    const second = ingestBytes(db, home, detection, 'NAVAPI-2', 'shot.png', PNG, 'paste')
    expect(second.deduped).toBe(false)
    expect(fs.existsSync(path.join(home, 'cases/NAVAPI-2/evidence/shot.png'))).toBe(true)
  })

  it('throws for an unknown case', () => {
    expect(() => ingestBytes(db, home, detection, 'NOPE-9', 'a.png', PNG, 'paste')).toThrow(
      /Unknown case/
    )
  })
})
