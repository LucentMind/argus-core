import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import { extractDerivedText } from '../extraction'
import { searchEvidence, readEvidenceText } from '../search'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync
const detection = createDetection(samplePackRegistry())

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bt-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-9', title: 'binlog case' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// fake sample-parse writing 3 decoded lines to the --output file ($4 / %4)
function writeFakeArgusParse(dir: string): string {
  if (process.platform === 'win32') {
    const bat = path.join(dir, 'sample-parse.bat')
    fs.writeFileSync(
      bat,
      '@echo off\r\n' +
        '(\r\n' +
        'echo 0 t ECU1 NAVI CTX1 startup\r\n' +
        'echo 1 t ECU1 NAVI CTX1 FATAL bearing jump at tunnel exit\r\n' +
        'echo 2 t ECU1 NAVI CTX1 shutdown\r\n' +
        ') > %4\r\n' +
        'echo done\r\n'
    )
    return bat
  }
  const sh = path.join(dir, 'sample-parse')
  fs.writeFileSync(
    sh,
    '#!/bin/sh\nprintf "0 t ECU1 NAVI CTX1 startup\\n1 t ECU1 NAVI CTX1 FATAL bearing jump at tunnel exit\\n2 t ECU1 NAVI CTX1 shutdown\\n" > "$4"\necho done\n'
  )
  fs.chmodSync(sh, 0o755)
  return sh
}

it('wave-1 part-2 exit shape: binary → derived text → FTS hit → viewer text at line', async () => {
  const bin = writeFakeArgusParse(tmp)

  const src = path.join(tmp, 'drive.binlog')
  fs.writeFileSync(src, Buffer.from('BINLOG\x01' + 'x'.repeat(64)))
  const rec = ingestArtifact(db, argusHome, detection, 'NAV-9', src)
  const derived = await extractDerivedText(db, argusHome, rec, { argusParse: bin })
  expect(derived).not.toBeNull()

  const hits = searchEvidence(db, 'bearing jump', { caseSlug: 'NAV-9' })
  expect(hits).toHaveLength(1)
  expect(hits[0].matchLine).toBe(2) // exact line for the citation deep-link
  expect(hits[0].relPath).toBe('evidence/.derived/drive.binlog.txt')

  const { content } = readEvidenceText(db, argusHome, hits[0].evidenceId)
  expect(content.split('\n')[hits[0].matchLine - 1]).toContain('FATAL bearing jump')
})
