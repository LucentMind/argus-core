import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { listCaseFiles, readCaseFile, resolveCasePath, FILE_READ_CAP } from '../caseFiles'

let tmp: string, argusHome: string, db: DatabaseSync

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cf-'))
  argusHome = path.join(tmp, 'ArgusHome')
  db = openDb(path.join(argusHome, 'argus.db'))
  createCase(db, argusHome, { slug: 'NAV-1', title: 'test' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const caseRoot = (): string => path.join(argusHome, 'cases', 'NAV-1')

// Junction creation can be denied by policy on some machines; probe once so the
// symlink-escape test skips instead of failing there.
const junctionsWork = ((): boolean => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cf-jn-'))
  try {
    const target = path.join(probe, 'target')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(probe, 'link'), 'junction')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
})()

describe('resolveCasePath', () => {
  it('resolves paths inside the case dir', () => {
    expect(resolveCasePath(argusHome, 'NAV-1', 'findings.md')).toBe(
      path.join(caseRoot(), 'findings.md')
    )
  })
  it.each(['../other', '..\\other', '/etc/passwd', 'C:\\Windows\\system32'])(
    'rejects escape: %s',
    (p) => {
      expect(() => resolveCasePath(argusHome, 'NAV-1', p)).toThrow(/outside the case directory/i)
    }
  )
  it.each(['../../../x', '..'])('rejects traversal via the slug: %s', (slug) => {
    expect(() => resolveCasePath(argusHome, slug, 'hosts')).toThrow(/invalid case slug/i)
  })
})

describe('listCaseFiles', () => {
  it('returns the tree with evidence metadata merged and junctions skipped', () => {
    const src = path.join(tmp, 'log.txt')
    fs.writeFileSync(src, 'hello\n')
    const rec = ingestArtifact(db, argusHome, 'NAV-1', src)
    const tree = listCaseFiles(db, argusHome, 'NAV-1')
    const names = tree.map((n) => n.name)
    expect(names).toContain('evidence')
    expect(names).toContain('findings.md')
    expect(names).not.toContain('.claude') // junction/symlink farm — never walked
    const evidenceDir = tree.find((n) => n.name === 'evidence')!
    const file = evidenceDir.children!.find((c) => c.name === 'log.txt')!
    expect(file.evidence).toMatchObject({ id: rec.id, derived: false })
    expect(file.size).toBeGreaterThan(0)
  })

  it('hides .meta and sorts dirs before files', () => {
    const tree = listCaseFiles(db, argusHome, 'NAV-1')
    const evidenceDir = tree.find((n) => n.name === 'evidence')!
    expect(evidenceDir.children!.map((c) => c.name)).not.toContain('.meta')
    const kinds = tree.map((n) => n.kind)
    expect(kinds.indexOf('file')).toBeGreaterThan(kinds.lastIndexOf('dir'))
  })
})

describe('readCaseFile', () => {
  it('reads a file inside the case dir', () => {
    const r = readCaseFile(argusHome, 'NAV-1', 'findings.md')
    expect('content' in r && r.content).toMatch(/# Findings/)
  })
  it('caps oversized files', () => {
    fs.writeFileSync(path.join(caseRoot(), 'big.txt'), Buffer.alloc(FILE_READ_CAP + 1))
    expect(readCaseFile(argusHome, 'NAV-1', 'big.txt')).toEqual({ tooLarge: true })
  })
  it.each(['../../../x', '..'])('rejects traversal via the slug: %s', (slug) => {
    expect(() => readCaseFile(argusHome, slug, 'hosts')).toThrow(/invalid case slug/i)
  })
  it.skipIf(!junctionsWork)('rejects reads through a junction escaping the case dir', () => {
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n')
    fs.symlinkSync(outside, path.join(caseRoot(), 'dir-link'), 'junction')
    expect(() => readCaseFile(argusHome, 'NAV-1', 'dir-link/secret.txt')).toThrow(
      /outside the case directory/i
    )
  })
  it('rejects a directory relPath', () => {
    expect(() => readCaseFile(argusHome, 'NAV-1', 'evidence')).toThrow(/not a file/i)
  })
})
