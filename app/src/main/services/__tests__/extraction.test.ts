import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact, listEvidence } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry, stubExtractors } from '../packs/__tests__/fixtures'
import { extractDerivedText } from '../extraction'
import { searchEvidence } from '../search'
import type { DatabaseSync } from 'node:sqlite'

let tmp: string, argusHome: string, db: DatabaseSync
const detection = createDetection(samplePackRegistry())

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-ext-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-1', title: 't' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// sample-parse stand-in that always writes one decoded line to the --output file, as a real
// script file (not process.execPath) — exercises the win32 .bat shell:true guard (CVE-2024-27980).
function writeFakeArgusParse(dir: string): string {
  if (process.platform === 'win32') {
    const bat = path.join(dir, 'sample-parse.bat')
    fs.writeFileSync(
      bat,
      '@echo off\r\n' +
        'echo 0 12:00 ECU1 NAVI CTX1 TunnelExit bearing jump detected> %4\r\n' +
        'echo wrote 1 messages to %4\r\n'
    )
    return bat
  }
  const sh = path.join(dir, 'sample-parse')
  fs.writeFileSync(
    sh,
    '#!/bin/sh\n' +
      'echo "0 12:00 ECU1 NAVI CTX1 TunnelExit bearing jump detected" > "$4"\n' +
      'echo "wrote 1 messages to $4"\n'
  )
  fs.chmodSync(sh, 0o755)
  return sh
}

describe('extraction pipeline', () => {
  it('derives text from a binlog artifact via a real script binary, indexes it with provenance', async () => {
    const fakeBin = writeFakeArgusParse(tmp)
    const src = path.join(tmp, 'trace.binlog')
    fs.writeFileSync(src, Buffer.from('BINLOG\x01binarybytes'))
    const rec = ingestArtifact(db, argusHome, detection, 'NAV-1', src)
    expect(rec.artifactType).toBe('binlog')

    const extractors = stubExtractors('binlog', {
      binPath: fakeBin,
      args: ['binlog-to-text', '{input}', '--output', '{output}']
    })
    const derived = await extractDerivedText(db, argusHome, rec, extractors)
    expect(derived).not.toBeNull()
    expect(derived!.relPath).toBe('evidence/.derived/trace.binlog.txt')
    expect(derived!.meta.derivedFrom).toBe(rec.id)

    const hits = searchEvidence(db, 'TunnelExit', { caseSlug: 'NAV-1' })
    expect(hits).toHaveLength(1)
    expect(hits[0].relPath).toBe('evidence/.derived/trace.binlog.txt')
    expect(hits[0].matchLine).toBe(1)
  })

  it('derives text via the node-stub extract command, exercising {input}/{output} substitution', async () => {
    const src = path.join(tmp, 'copy.binlog')
    fs.writeFileSync(src, '0 12:00 ECU1 NAVI CTX1 TunnelExit bearing jump detected\n')
    const rec = ingestArtifact(db, argusHome, detection, 'NAV-1', src)

    const derived = await extractDerivedText(db, argusHome, rec, stubExtractors('binlog'))
    expect(derived).not.toBeNull()

    const hits = searchEvidence(db, 'TunnelExit', { caseSlug: 'NAV-1' })
    expect(hits).toHaveLength(1)
    expect(hits[0].relPath).toBe('evidence/.derived/copy.binlog.txt')
  })

  it('returns null instead of throwing when the binary is missing', async () => {
    const src = path.join(tmp, 'trace2.binlog')
    fs.writeFileSync(src, Buffer.from('BINLOG\x01binarybytes'))
    const rec = ingestArtifact(db, argusHome, detection, 'NAV-1', src)
    await expect(
      extractDerivedText(db, argusHome, rec, stubExtractors('binlog', { resolves: false }))
    ).resolves.toBeNull()
    expect(listEvidence(db, 'NAV-1')).toHaveLength(1) // only trace2.binlog — no derived row appeared
  })

  it('ignores non-extractable artifact types', async () => {
    const src = path.join(tmp, 'notes.txt')
    fs.writeFileSync(src, 'plain text\n')
    const rec = ingestArtifact(db, argusHome, detection, 'NAV-1', src)
    await expect(extractDerivedText(db, argusHome, rec, stubExtractors('binlog'))).resolves.toBeNull()
  })
})
