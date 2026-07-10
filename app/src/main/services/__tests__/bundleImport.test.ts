import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Zip, extract } from 'zip-lib'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { ingestContent, ingestDerived, listEvidence } from '../ingest'
import { searchEvidence } from '../search'
import { exportCase, importCase, inspectBundle, proposeSlug } from '../bundle'
import type { DatabaseSync } from 'node:sqlite'

let homeA: string
let homeB: string
let dbA: DatabaseSync
let dbB: DatabaseSync
let bundle: string

beforeEach(async () => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-imp-a-'))
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-imp-b-'))
  dbA = openDb(path.join(homeA, 'argus.db'))
  dbB = openDb(path.join(homeB, 'argus.db'))
  createCase(dbA, homeA, { slug: 'NAV-100', title: 'Tile region fails' })
  ingestContent(dbA, homeA, 'NAV-100', 'boot.txt', 'ERROR BLOCKED_VERSION tile=42\n', 'upload')
  // a derived artifact so the id-remap path is exercised
  const parent = listEvidence(dbA, 'NAV-100')[0]
  const derivedDir = path.join(homeA, 'cases', 'NAV-100', 'evidence', '.derived')
  fs.mkdirSync(derivedDir, { recursive: true })
  fs.writeFileSync(path.join(derivedDir, 'boot.derived.txt'), 'derived BLOCKED_VERSION text\n')
  ingestDerived(dbA, homeA, 'NAV-100', path.join(derivedDir, 'boot.derived.txt'), parent.id)
  fs.appendFileSync(
    path.join(homeA, 'cases', 'NAV-100', 'findings.md'),
    '\n## F1\nBLOCKED_VERSION seen\n'
  )
  bundle = path.join(homeA, 'NAV-100.arguscase')
  await exportCase(
    dbA,
    homeA,
    'NAV-100',
    bundle,
    { includeTranscripts: true },
    {
      argusVersion: '1.0.0'
    }
  )
})
afterEach(() => {
  dbA.close()
  dbB.close()
  for (const h of [homeA, homeB]) fs.rmSync(h, { recursive: true, force: true })
})

describe('inspectBundle / proposeSlug', () => {
  it('reads the manifest and proposes the original slug on a fresh home', async () => {
    const insp = await inspectBundle(dbB, homeB, bundle)
    expect(insp.manifest.slug).toBe('NAV-100')
    expect(insp.proposedSlug).toBe('NAV-100')
    expect(insp.collision).toBe(false)
  })

  it('suffixes on collision', () => {
    expect(proposeSlug(dbA, homeA, 'NAV-100')).toEqual({ slug: 'NAV-100-2', collision: true })
  })

  it('refuses a newer bundle format with a clear message', async () => {
    // rebuild the bundle with format bumped
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tamper-'))
    await extract(bundle, tmp)
    const mf = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
    mf.format = 99
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(mf))
    const newer = path.join(tmp, 'newer.arguscase')
    const zip = new Zip()
    zip.addFile(path.join(tmp, 'manifest.json'), 'manifest.json')
    zip.addFolder(path.join(tmp, 'case'), 'case')
    await zip.archive(newer)
    await expect(inspectBundle(dbB, homeB, newer)).rejects.toThrow(/format v99/)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects a zip without a manifest', async () => {
    const junk = path.join(homeB, 'junk.arguscase')
    const zip = new Zip()
    const f = path.join(homeB, 'x.txt')
    fs.writeFileSync(f, 'not a bundle')
    zip.addFile(f, 'x.txt')
    await zip.archive(junk)
    await expect(inspectBundle(dbB, homeB, junk)).rejects.toThrow(/manifest\.json missing/)
  })
})

describe('importCase', () => {
  it('round-trips: files land, evidence rows rebuilt, FTS live, derived remapped', async () => {
    const rec = await importCase(dbB, homeB, bundle, 'NAV-100')
    expect(rec.slug).toBe('NAV-100')
    const dir = path.join(homeB, 'cases', 'NAV-100')
    expect(fs.readFileSync(path.join(dir, 'findings.md'), 'utf8')).toContain('BLOCKED_VERSION')
    expect(fs.existsSync(path.join(dir, 'sessions'))).toBe(true)
    // junction farm re-scaffolded, not imported (skills target absent in temp home -> skipped, no throw)
    expect(fs.existsSync(path.join(dir, '.claude'))).toBe(true)
    // FTS is live immediately
    const hits = searchEvidence(dbB, 'BLOCKED_VERSION', { caseSlug: 'NAV-100' })
    expect(hits.length).toBeGreaterThan(0)
    // derived remap: derivedFrom points at the NEW parent id
    const evs = listEvidence(dbB, 'NAV-100')
    const parent = evs.find((e) => e.relPath === 'evidence/boot.txt')!
    const derived = evs.find((e) => e.relPath === 'evidence/.derived/boot.derived.txt')!
    expect(derived.meta.derivedFrom).toBe(parent.id)
    // sidecars rewritten with new ids
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(dir, 'evidence', '.meta', 'boot.txt.json'), 'utf8')
    )
    expect(sidecar.id).toBe(parent.id)
    // imported workspaces land as unlinked refs; local workspaces stay empty
    const cj = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'))
    expect(cj.workspaces).toEqual([])
    expect(Array.isArray(cj.workspaceRefs)).toBe(true)
    expect(cj.slug).toBe('NAV-100')
  })

  it('refuses a tampered bundle and writes nothing', async () => {
    // tamper: change a file's bytes without updating the manifest hash
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tamper2-'))
    await extract(bundle, tmp)
    fs.appendFileSync(path.join(tmp, 'case', 'findings.md'), 'TAMPERED\n')
    const bad = path.join(tmp, 'bad.arguscase')
    const zip = new Zip()
    zip.addFile(path.join(tmp, 'manifest.json'), 'manifest.json')
    zip.addFolder(path.join(tmp, 'case'), 'case')
    await zip.archive(bad)
    await expect(importCase(dbB, homeB, bad, 'NAV-100')).rejects.toThrow(/checksum mismatch/)
    expect(getCase(dbB, 'NAV-100')).toBeNull()
    expect(fs.existsSync(path.join(homeB, 'cases', 'NAV-100'))).toBe(false)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('imports under a suffixed slug and rewrites case.json', async () => {
    createCase(dbB, homeB, { slug: 'NAV-100', title: 'occupies the slug' })
    const { slug } = proposeSlug(dbB, homeB, 'NAV-100')
    const rec = await importCase(dbB, homeB, bundle, slug)
    expect(rec.slug).toBe('NAV-100-2')
    const cj = JSON.parse(
      fs.readFileSync(path.join(homeB, 'cases', 'NAV-100-2', 'case.json'), 'utf8')
    )
    expect(cj.slug).toBe('NAV-100-2')
  })
})
