import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { readReportMarkdown, writeReportMarkdown, reportFile } from '../rca/artifacts'
import { artifactsDir } from '../paths'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { freezeCase } from '../caseFreeze'

let home: string
// writeReportMarkdown now takes a db purely for the archive guard. These tests seed no `cases`
// row unless they are about the guard, and assertCaseWritable passes on an unknown slug, so
// every pre-existing assertion below is unchanged by the extra argument.
let db: DatabaseSync

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
  db = openDb(path.join(home, 'argus.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function seed(slug: string, exec: string, tech: string): void {
  const dir = artifactsDir(home, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'rca-exec.md'), exec)
  fs.writeFileSync(path.join(dir, 'rca-tech.md'), tech)
}

describe('readReportMarkdown', () => {
  it('returns both reports', () => {
    seed('case-a', '# exec', '# tech')
    expect(readReportMarkdown(home, 'case-a')).toEqual({ exec: '# exec', tech: '# tech' })
  })

  it('returns null when the case has never been confirmed', () => {
    expect(readReportMarkdown(home, 'case-a')).toBeNull()
  })

  it('returns null when only one of the two files exists', () => {
    const dir = artifactsDir(home, 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'rca-exec.md'), '# exec')
    expect(readReportMarkdown(home, 'case-a')).toBeNull()
  })
})

describe('writeReportMarkdown', () => {
  it('overwrites one report without touching the other', () => {
    seed('case-a', '# exec', '# tech')
    writeReportMarkdown(db, home, 'case-a', 'exec', '# edited')
    expect(readReportMarkdown(home, 'case-a')).toEqual({ exec: '# edited', tech: '# tech' })
  })

  it('writes bytes verbatim, including trailing whitespace and CRLF', () => {
    seed('case-a', 'a', 'b')
    writeReportMarkdown(db, home, 'case-a', 'tech', 'line\r\n  trailing  ')
    expect(readReportMarkdown(home, 'case-a')!.tech).toBe('line\r\n  trailing  ')
  })

  it('refuses to write a case that has no artifacts directory', () => {
    expect(() => writeReportMarkdown(db, home, 'case-a', 'exec', 'x')).toThrow(/no confirmed/i)
  })
})

describe('writeReportMarkdown refuses a case whose bundle is being or has been sealed', () => {
  // Both refusals matter: a hand-edit saved DURING the archive lands after the bundle is
  // sealed and is then deleted with the rest of artifacts/; one saved AFTER archiving leaves
  // the file on disk disagreeing with the sealed copy a restore would put back.
  it('throws while the case is frozen, and leaves the file byte-identical', () => {
    createCase(db, home, { slug: 'case-f', title: 'Case F' })
    seed('case-f', '# exec', '# tech')
    const freeze = freezeCase('case-f')
    try {
      expect(() => writeReportMarkdown(db, home, 'case-f', 'exec', '# snuck in')).toThrow(
        /being archived/i
      )
    } finally {
      freeze.release()
    }
    expect(readReportMarkdown(home, 'case-f')!.exec).toBe('# exec')
  })

  it('throws once the case is archived, and leaves the file byte-identical', () => {
    createCase(db, home, { slug: 'case-g', title: 'Case G' })
    seed('case-g', '# exec', '# tech')
    db.prepare(`UPDATE cases SET archived_at = ? WHERE slug = ?`).run(
      new Date().toISOString(),
      'case-g'
    )
    expect(() => writeReportMarkdown(db, home, 'case-g', 'exec', '# snuck in')).toThrow(/archived/i)
    expect(readReportMarkdown(home, 'case-g')!.exec).toBe('# exec')
  })
})

describe('reportFile', () => {
  it('resolves inside the case artifacts dir', () => {
    const f = reportFile(home, 'case-a', 'exec')
    expect(f.startsWith(artifactsDir(home, 'case-a'))).toBe(true)
    expect(path.basename(f)).toBe('rca-exec.md')
  })
})
