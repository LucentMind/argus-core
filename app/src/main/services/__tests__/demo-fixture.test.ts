import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { searchEvidence } from '../search'

const FIXTURE = path.resolve(__dirname, '../../../../../tests/fixtures/demo-applog.txt')

describe('demo fixture (multi-chunk deep-link)', () => {
  it('resolves exact match lines beyond the first FTS chunk', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-demo-'))
    const db = openDb(path.join(home, 'argus.db'))
    createCase(db, home, { slug: 'DEMO-1', title: 'demo' })
    const ev = ingestArtifact(db, home, 'DEMO-1', FIXTURE)
    expect(ev.artifactType).toBe('applog')

    // marker planted at line 857 — inside the third 400-line chunk (801–1200)
    const blocked = searchEvidence(db, 'BLOCKED_VERSION', { caseSlug: 'DEMO-1' })
    expect(blocked).toHaveLength(1)
    expect(blocked[0].startLine).toBe(801)
    expect(blocked[0].endLine).toBe(1200)
    expect(blocked[0].matchLine).toBe(857)

    // multi-term query, marker at line 1101
    const binder = searchEvidence(db, 'binder transaction failed', { caseSlug: 'DEMO-1' })
    expect(binder).toHaveLength(1)
    expect(binder[0].matchLine).toBe(1101)
  })
})
