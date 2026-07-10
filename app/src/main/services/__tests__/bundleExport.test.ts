import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { extract } from 'zip-lib'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestContent, sha256File } from '../ingest'
import { collectCaseFiles, exportCase } from '../bundle'
import { bundleManifestSchema } from '../../../shared/bundle'
import type { DatabaseSync } from 'node:sqlite'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-export-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAV-100', title: 'Tile region fails' })
  ingestContent(db, home, 'NAV-100', 'boot.txt', 'ERROR BLOCKED_VERSION tile=42\n', 'upload')
  fs.writeFileSync(path.join(home, 'cases', 'NAV-100', 'sessions', '1.jsonl'), '{"type":"x"}\n')
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('collectCaseFiles', () => {
  it('lists case files, POSIX-relative, excluding .claude; sessions honor the toggle', () => {
    const dir = path.join(home, 'cases', 'NAV-100')
    const withT = collectCaseFiles(dir, { includeTranscripts: true })
    expect(withT).toContain('case.json')
    expect(withT).toContain('evidence/boot.txt')
    expect(withT).toContain('evidence/.meta/boot.txt.json')
    expect(withT).toContain('sessions/1.jsonl')
    expect(withT.some((p) => p.startsWith('.claude'))).toBe(false)
    const withoutT = collectCaseFiles(dir, { includeTranscripts: false })
    expect(withoutT.some((p) => p.startsWith('sessions/'))).toBe(false)
  })
})

describe('exportCase', () => {
  it('writes a zip with manifest.json + case/ prefix and correct hashes', async () => {
    const dest = path.join(home, 'NAV-100.arguscase')
    const manifest = await exportCase(
      db,
      home,
      'NAV-100',
      dest,
      { includeTranscripts: true },
      {
        argusVersion: '1.0.0'
      }
    )
    expect(fs.existsSync(dest)).toBe(true)
    expect(manifest.format).toBe(1)
    expect(manifest.slug).toBe('NAV-100')
    expect(manifest.includesTranscripts).toBe(true)

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-unzip-'))
    await extract(dest, out)
    const onDisk = bundleManifestSchema.parse(
      JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    )
    expect(onDisk.files.map((f) => f.path).sort()).toEqual(manifest.files.map((f) => f.path).sort())
    for (const f of onDisk.files) {
      const abs = path.join(out, 'case', ...f.path.split('/'))
      expect(sha256File(abs)).toBe(f.sha256)
    }
    expect(fs.existsSync(path.join(out, 'case', '.claude'))).toBe(false)
    fs.rmSync(out, { recursive: true, force: true })
  })

  it('carries imported workspaceRefs from case.json into the re-exported manifest', async () => {
    const caseJsonPath = path.join(home, 'cases', 'NAV-100', 'case.json')
    const onDisk = JSON.parse(fs.readFileSync(caseJsonPath, 'utf8')) as Record<string, unknown>
    onDisk.workspaceRefs = [
      { remote: 'https://github.com/org/x.git', branch: 'main', commit: 'abc' }
    ]
    fs.writeFileSync(caseJsonPath, JSON.stringify(onDisk, null, 2))

    const dest = path.join(home, 'NAV-100.arguscase')
    const manifest = await exportCase(
      db,
      home,
      'NAV-100',
      dest,
      { includeTranscripts: true },
      { argusVersion: '1.0.0' }
    )
    expect(manifest.workspaces).toContainEqual({
      remote: 'https://github.com/org/x.git',
      branch: 'main',
      commit: 'abc'
    })
  })

  it('throws on an unknown case', async () => {
    await expect(
      exportCase(
        db,
        home,
        'NOPE',
        path.join(home, 'x.arguscase'),
        { includeTranscripts: true },
        {
          argusVersion: '1.0.0'
        }
      )
    ).rejects.toThrow(/Unknown case/)
  })
})
