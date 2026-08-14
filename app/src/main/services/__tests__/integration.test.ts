import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../db'
import { createCase } from '../caseService'
import { ingestArtifact } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import { searchEvidence, readEvidenceText } from '../search'
import { createImmediateQueue } from '../ingestQueue'

const FIXTURE = path.resolve(__dirname, '../../../../../tests/fixtures/sample-applog.txt')

describe('wave 0 exit criterion (service level)', () => {
  it('create case → ingest applog → search string → read at line', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-e2e-'))
    const db = openDb(path.join(home, 'argus.db'))
    const detection = createDetection(samplePackRegistry())

    createCase(db, home, { slug: 'NAVAPI-777', title: 'exit criterion' })
    const ev = await ingestArtifact(
      db,
      home,
      detection,
      createImmediateQueue(db, home),
      'NAVAPI-777',
      FIXTURE
    )
    expect(ev.artifactType).toBe('applog')

    const hits = searchEvidence(db, 'TileStore error', { caseSlug: 'NAVAPI-777' })
    expect(hits).toHaveLength(1)
    expect(hits[0].evidenceId).toBe(ev.id)

    const doc = readEvidenceText(db, home, hits[0].evidenceId)
    const lines = doc.content.split('\n')
    const match = lines.findIndex((l) => l.includes('TileStore error')) + 1
    expect(hits[0].matchLine).toBe(match)
    expect(match).toBeGreaterThanOrEqual(hits[0].startLine)
    expect(match).toBeLessThanOrEqual(hits[0].endLine)
  })
})
