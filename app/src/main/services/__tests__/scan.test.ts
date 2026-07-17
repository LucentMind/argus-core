import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { caseDir } from '../paths'
import { createCase } from '../caseService'
import { ingestContent, listEvidence } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry, stubExtractors } from '../packs/__tests__/fixtures'
import { scanEvidence, type ScanDeps } from '../scan'

let tmp: string, argusHome: string, db: DatabaseSync, changed: string[]
const detection = createDetection(samplePackRegistry())
// 'binlog' is not matched by any of our plain .txt/.log test fixtures — no
// extractable types among them; extraction itself is covered by extraction.test.ts.
const extractors = stubExtractors('binlog')
const deps = (): ScanDeps => ({
  evidenceChanged: (s: string) => changed.push(s),
  parsing: vi.fn()
})
const evDir = (slug: string): string => path.join(caseDir(argusHome, slug), 'evidence')

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-scan-'))
  argusHome = path.join(tmp, 'home')
  db = openDb(path.join(argusHome, 'argus.db'))
  changed = []
  createCase(db, argusHome, { slug: 'C1', title: 'T' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('scanEvidence', () => {
  it('registers untracked files in place, including nested subfolders', () => {
    fs.writeFileSync(path.join(evDir('C1'), 'dropped.txt'), 'external file one')
    fs.mkdirSync(path.join(evDir('C1'), 'sub', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(evDir('C1'), 'sub', 'deep', 'nested.log'), 'nested content')
    const s = scanEvidence(db, argusHome, detection, extractors, deps(), 'C1')
    expect(s.added.sort()).toEqual(['evidence/dropped.txt', 'evidence/sub/deep/nested.log'])
    const ev = listEvidence(db, 'C1')
    const nested = ev.find((e) => e.relPath === 'evidence/sub/deep/nested.log')!
    expect(nested.origin).toBe('scan')
    // registered in place — no copy appeared at the top level
    expect(fs.readdirSync(evDir('C1')).filter((n) => !n.startsWith('.'))).toEqual(
      expect.arrayContaining(['dropped.txt', 'sub'])
    )
    // sidecar written for the nested file
    expect(fs.existsSync(path.join(evDir('C1'), '.meta', 'sub', 'deep', 'nested.log.json'))).toBe(
      true
    )
    // FTS-indexed
    const hit = db
      .prepare(`SELECT count(*) c FROM evidence_fts WHERE evidence_fts MATCH 'nested'`)
      .get() as { c: number }
    expect(hit.c).toBeGreaterThan(0)
    expect(changed).toEqual(['C1'])
  })

  it('detects modified files: re-hash, priorSha256, re-index', () => {
    const rec = ingestContent(db, argusHome, detection, 'C1', 'a.txt', 'original words', 'upload')
    fs.writeFileSync(path.join(caseDir(argusHome, 'C1'), rec.relPath), 'replaced entirely zzqy')
    const s = scanEvidence(db, argusHome, detection, extractors, deps(), 'C1')
    expect(s.modified).toEqual(['evidence/a.txt'])
    const after = listEvidence(db, 'C1').find((e) => e.id === rec.id)!
    expect(after.sha256).not.toBe(rec.sha256)
    expect(after.meta.priorSha256).toBe(rec.sha256)
    const hit = db
      .prepare(`SELECT count(*) c FROM evidence_fts WHERE evidence_fts MATCH 'zzqy'`)
      .get() as { c: number }
    expect(hit.c).toBeGreaterThan(0)
  })

  it('flags missing files without deleting rows, and clears the flag on return', () => {
    const rec = ingestContent(db, argusHome, detection, 'C1', 'gone.txt', 'bye', 'upload')
    const abs = path.join(caseDir(argusHome, 'C1'), rec.relPath)
    fs.rmSync(abs)
    let s = scanEvidence(db, argusHome, detection, extractors, deps(), 'C1')
    expect(s.missing).toEqual(['evidence/gone.txt'])
    expect(listEvidence(db, 'C1').find((e) => e.id === rec.id)!.meta.missing).toBe(true)
    fs.writeFileSync(abs, 'bye') // same content returns
    s = scanEvidence(db, argusHome, detection, extractors, deps(), 'C1')
    expect(s.missing).toEqual([])
    expect(listEvidence(db, 'C1').find((e) => e.id === rec.id)!.meta.missing).toBeUndefined()
  })

  it('skips dot-directories on disk and dot-path records in the missing check', () => {
    ingestContent(db, argusHome, detection, 'C1', 'src.txt', 'source', 'upload')
    // simulate a derived record whose file lives under evidence/.derived (walk skips it)
    fs.mkdirSync(path.join(evDir('C1'), '.derived'), { recursive: true })
    fs.writeFileSync(path.join(evDir('C1'), '.derived', 'src.txt.txt'), 'derived text')
    db.prepare(
      `INSERT INTO evidence (case_id, rel_path, sha256, artifact_type, size, origin, meta, created_at)
       VALUES (1, 'evidence/.derived/src.txt.txt', 'x', 'text', 12, 'agent', '{}', 'now')`
    ).run()
    const s = scanEvidence(db, argusHome, detection, extractors, deps(), 'C1')
    expect(s.added).toEqual([]) // .derived content not re-ingested
    expect(s.missing).toEqual([]) // .derived record not flagged missing
  })

  it('isolates per-file failures as errors and continues', () => {
    // Force a mid-registration failure portably (chmod is unreliable on Windows):
    // make evidence/.meta a FILE, so the sidecar write's mkdirSync throws for
    // every registration — the file still lands in errors, not an aborted scan.
    fs.rmSync(path.join(evDir('C1'), '.meta'), { recursive: true, force: true })
    fs.writeFileSync(path.join(evDir('C1'), '.meta'), 'not a dir')
    fs.writeFileSync(path.join(evDir('C1'), 'ok.txt'), 'fine')
    const s = scanEvidence(db, argusHome, detection, extractors, deps(), 'C1')
    expect(s.errors).toHaveLength(1)
    expect(s.errors[0].relPath).toBe('evidence/ok.txt')
    expect(s.added).toEqual([]) // the failed file is not reported as added
  })
})
