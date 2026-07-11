import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Zip, extract } from 'zip-lib'
import { openDb } from '../db'
import { createCase, getCase } from '../caseService'
import { ingestContent, ingestDerived, listEvidence, sha256File } from '../ingest'
import { createDetection } from '../packs/detection'
import { searchEvidence } from '../search'
import { exportCase, importCase, inspectBundle, proposeSlug } from '../bundle'
import { listSessions } from '../agent/sessionStore'
import { readSessionEvents } from '../agent/mirror'
import type { DatabaseSync } from 'node:sqlite'

let homeA: string
let homeB: string
let dbA: DatabaseSync
let dbB: DatabaseSync
let bundle: string
const detection = createDetection()

beforeEach(async () => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-imp-a-'))
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-imp-b-'))
  dbA = openDb(path.join(homeA, 'argus.db'))
  dbB = openDb(path.join(homeB, 'argus.db'))
  createCase(dbA, homeA, { slug: 'NAV-100', title: 'Tile region fails' })
  ingestContent(
    dbA,
    homeA,
    detection,
    'NAV-100',
    'boot.txt',
    'ERROR BLOCKED_VERSION tile=42\n',
    'upload'
  )
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

/**
 * Stage a copy of the base `bundle` with `case.json` patched (e.g. status/
 * resolution), re-hashing the manifest entry for the swapped file so the
 * integrity check in importCase still passes.
 */
async function bundleWithCaseJson(patch: Record<string, unknown>): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-resolution-'))
  await extract(bundle, tmp)
  const cjPath = path.join(tmp, 'case', 'case.json')
  const cj = JSON.parse(fs.readFileSync(cjPath, 'utf8'))
  fs.writeFileSync(cjPath, JSON.stringify({ ...cj, ...patch }, null, 2))
  const mfPath = path.join(tmp, 'manifest.json')
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8')) as {
    files: { path: string; sha256: string; size: number }[]
  }
  const entry = mf.files.find((f) => f.path === 'case.json')!
  entry.sha256 = sha256File(cjPath)
  entry.size = fs.statSync(cjPath).size
  fs.writeFileSync(mfPath, JSON.stringify(mf))
  const out = path.join(tmp, 'patched.arguscase')
  const zip = new Zip()
  zip.addFile(mfPath, 'manifest.json')
  zip.addFolder(path.join(tmp, 'case'), 'case')
  await zip.archive(out)
  return out
}

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

  it('rolls back the landed directory and orphan FTS rows when a post-rename step fails', async () => {
    // exploit: the integrity loop only verifies manifest-LISTED files, so an extra
    // staged sidecar (not in the manifest) sails through untouched. Duplicate a sidecar
    // so reindex hits a UNIQUE(case_id, rel_path) violation AFTER the rename has landed.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tamper3-'))
    await extract(bundle, tmp)
    const metaDir = path.join(tmp, 'case', 'evidence', '.meta')
    fs.copyFileSync(path.join(metaDir, 'boot.txt.json'), path.join(metaDir, 'boot-dup.txt.json'))
    const bad = path.join(tmp, 'dup-sidecar.arguscase')
    const zip = new Zip()
    zip.addFile(path.join(tmp, 'manifest.json'), 'manifest.json')
    zip.addFolder(path.join(tmp, 'case'), 'case')
    await zip.archive(bad)

    await expect(importCase(dbB, homeB, bad, 'NAV-100')).rejects.toThrow()
    expect(getCase(dbB, 'NAV-100')).toBeNull()
    expect(fs.existsSync(path.join(homeB, 'cases', 'NAV-100'))).toBe(false)
    const ftsCount = dbB.prepare('SELECT COUNT(*) AS n FROM evidence_fts').get() as { n: number }
    expect(ftsCount.n).toBe(0)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects a manifest listing an unsafe (traversal) path and writes nothing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tamper-manifest-'))
    await extract(bundle, tmp)
    const mf = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
    mf.files.push({ path: '../escape.txt', sha256: '0', size: 1 })
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(mf))
    const bad = path.join(tmp, 'bad-manifest.arguscase')
    const zip = new Zip()
    zip.addFile(path.join(tmp, 'manifest.json'), 'manifest.json')
    zip.addFolder(path.join(tmp, 'case'), 'case')
    await zip.archive(bad)

    await expect(importCase(dbB, homeB, bad, 'NAV-100')).rejects.toThrow(/unsafe path/)
    expect(getCase(dbB, 'NAV-100')).toBeNull()
    expect(fs.existsSync(path.join(homeB, 'cases', 'NAV-100'))).toBe(false)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('skips a sidecar with an unsafe (traversal) relPath, leaving no rogue rows', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-tamper-sidecar-'))
    await extract(bundle, tmp)
    const metaDir = path.join(tmp, 'case', 'evidence', '.meta')
    const good = JSON.parse(fs.readFileSync(path.join(metaDir, 'boot.txt.json'), 'utf8'))
    const evil = { ...good, id: 9999, relPath: '../../outside.txt', meta: { indexed: true } }
    fs.writeFileSync(path.join(metaDir, 'evil.json'), JSON.stringify(evil, null, 2))
    const bad = path.join(tmp, 'evil-sidecar.arguscase')
    const zip = new Zip()
    zip.addFile(path.join(tmp, 'manifest.json'), 'manifest.json')
    zip.addFolder(path.join(tmp, 'case'), 'case')
    await zip.archive(bad)

    const rec = await importCase(dbB, homeB, bad, 'NAV-100')
    expect(rec.slug).toBe('NAV-100')
    const evs = listEvidence(dbB, 'NAV-100')
    expect(evs.every((e) => !e.relPath.includes('..'))).toBe(true)

    // FTS row count matches a clean import — no extra index rows landed for the hostile sidecar
    const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-imp-c-'))
    const dbC = openDb(path.join(homeC, 'argus.db'))
    await importCase(dbC, homeC, bundle, 'NAV-100')
    const cleanCount = (
      dbC.prepare('SELECT COUNT(*) AS n FROM evidence_fts').get() as { n: number }
    ).n
    const hostileCount = (
      dbB.prepare('SELECT COUNT(*) AS n FROM evidence_fts').get() as { n: number }
    ).n
    expect(hostileCount).toBe(cleanCount)
    dbC.close()
    fs.rmSync(homeC, { recursive: true, force: true })
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('imported transcripts under the multi-session model (WP-D seam)', () => {
  it('registers sessions rows, rewrites envelopes, renames files to the new ids', async () => {
    // transcript named by a foreign autoincrement id, envelopes carrying the OLD identity
    const sessA = path.join(homeA, 'cases', 'NAV-100', 'sessions')
    const oldEnvelope = {
      eventId: 'e1',
      caseId: 1,
      caseSlug: 'NAV-100',
      sessionId: 7,
      turnId: 1,
      ts: '2026-07-10T00:00:00.000Z'
    }
    fs.writeFileSync(
      path.join(sessA, '7.jsonl'),
      JSON.stringify({
        ...oldEnvelope,
        type: 'turn.started',
        payload: { userText: 'why did tiles fail on the head unit?' }
      }) +
        '\n' +
        JSON.stringify({
          ...oldEnvelope,
          eventId: 'e2',
          type: 'assistant.message',
          payload: { text: 'BLOCKED_VERSION analysis' }
        }) +
        '\n'
    )
    const b2 = path.join(homeA, 'NAV-100-t.arguscase')
    await exportCase(
      dbA,
      homeA,
      'NAV-100',
      b2,
      { includeTranscripts: true },
      { argusVersion: '1.0.0' }
    )

    // occupy the slug so the import lands suffixed — envelope slug must follow
    createCase(dbB, homeB, { slug: 'NAV-100', title: 'occupies the slug' })
    const rec = await importCase(dbB, homeB, b2, proposeSlug(dbB, homeB, 'NAV-100').slug)
    expect(rec.slug).toBe('NAV-100-2')

    const sessions = listSessions(dbB, rec.slug)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('why did tiles fail on the head unit?')
    expect(sessions[0].turnCount).toBe(1)

    const caseDirB = path.join(homeB, 'cases', rec.slug)
    const events = readSessionEvents(caseDirB, sessions[0].id)
    expect(events.some((e) => e.type === 'assistant.message')).toBe(true)
    // envelopes rewritten to the NEW identity — the renderer keys hydration off these
    for (const e of events) {
      expect(e.caseSlug).toBe(rec.slug)
      expect(e.sessionId).toBe(sessions[0].id)
      expect(e.caseId).toBe(rec.id)
    }
    // the foreign-named file is gone (renamed), not duplicated
    expect(fs.existsSync(path.join(caseDirB, 'sessions', '7.jsonl'))).toBe(false)
    expect(fs.readdirSync(path.join(caseDirB, 'sessions'))).toHaveLength(1)
  })

  it('a no-transcript import registers no sessions (switcher creates the first one lazily)', async () => {
    const b3 = path.join(homeA, 'NAV-100-nt.arguscase')
    await exportCase(
      dbA,
      homeA,
      'NAV-100',
      b3,
      { includeTranscripts: false },
      { argusVersion: '1.0.0' }
    )
    await importCase(dbB, homeB, b3, 'NAV-100')
    const rows = dbB
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s JOIN cases c ON c.id = s.case_id WHERE c.slug = ?`
      )
      .get('NAV-100') as { n: number }
    expect(rows.n).toBe(0)
  })
})

describe('imported case resolution', () => {
  it('imports a closed case with its resolution', async () => {
    const patched = await bundleWithCaseJson({ status: 'closed', resolution: 'duplicate' })
    const rec = await importCase(dbB, homeB, patched, 'NAV-100')
    expect(rec.status).toBe('closed')
    expect(rec.resolution).toBe('duplicate')
  })

  it('drops a stray resolution on a non-closed imported case', async () => {
    const patched = await bundleWithCaseJson({ status: 'open', resolution: 'duplicate' })
    const rec = await importCase(dbB, homeB, patched, 'NAV-100')
    expect(rec.status).toBe('open')
    expect(rec.resolution).toBeNull()
  })
})
