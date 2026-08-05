import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../db'
import { createCase } from '../../caseService'
import { listEvidence } from '../../ingest'
import { createDetection } from '../../packs/detection'
import { attachCorpusEvidence, type AttachDeps } from '../attach'
import type { CorpusDefectRecord } from '../../defectCorpus/client'
import type { DefectCorpusService } from '../../defectCorpus/service'

const record = (over: Partial<CorpusDefectRecord> = {}): CorpusDefectRecord =>
  ({
    key: 'KAN-42',
    url: 'https://corpus.example/browse/KAN-42',
    project: 'KAN',
    summary: 'charge plan dropped after reset',
    description: 'Reset the ECU, then read the plan.',
    status: 'Done',
    resolution: 'Fixed',
    components: [],
    labels: [],
    affectsVersions: [],
    fixVersions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: '2026-01-03T00:00:00.000Z',
    links: [],
    commentCount: 0,
    distilled: null,
    ...over
  }) as CorpusDefectRecord

let home: string
let db: DatabaseSync
const detection = createDetection()

/** Only the corpus is faked; the db, the filesystem and ingest are real. */
function deps(over: Partial<AttachDeps> = {}): AttachDeps {
  const corpus = {
    enabledSources: () => [{ id: 'src1', name: 'Hindsight', baseUrl: 'https://corpus.example' }],
    getDefect: async () => ({ ok: true as const, value: record() })
  } as unknown as DefectCorpusService
  return {
    db,
    argusHome: home,
    detection,
    defectCorpus: corpus,
    ...over
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-attach-'))
  db = openDb(path.join(home, 'argus.db'))
  createCase(db, home, { slug: 'NAV-100', title: 'Tile region fails' })
})

describe('attachCorpusEvidence', () => {
  it("writes the snapshot into the case's evidence tree with origin 'corpus'", async () => {
    const res = await attachCorpusEvidence(deps(), 'NAV-100', 'src1', 'KAN-42')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.deduped).toBe(false)
    expect(res.record.origin).toBe('corpus')
    expect(res.record.relPath.endsWith('KAN-42.md')).toBe(true)

    const listed = listEvidence(db, 'NAV-100')
    expect(listed).toHaveLength(1)
    expect(listed[0].origin).toBe('corpus')

    const onDisk = fs.readFileSync(path.join(home, 'cases', 'NAV-100', listed[0].relPath), 'utf8')
    expect(onDisk).toContain('# KAN-42 — charge plan dropped after reset')
    expect(onDisk).toContain('captured from the "Hindsight" corpus')
  })

  it('records the source and the key as evidence metadata', async () => {
    const res = await attachCorpusEvidence(deps(), 'NAV-100', 'src1', 'KAN-42')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record.meta).toMatchObject({
      sourceId: 'src1',
      defectKey: 'KAN-42',
      sourceUrl: 'https://corpus.example/browse/KAN-42'
    })
  })

  it('omits a non-http(s) url from the metadata rather than storing it', async () => {
    const corpus = {
      enabledSources: () => [{ id: 'src1', name: 'Hindsight', baseUrl: 'x' }],
      getDefect: async () => ({ ok: true as const, value: record({ url: 'javascript:alert(1)' }) })
    } as unknown as DefectCorpusService
    const res = await attachCorpusEvidence(
      deps({ defectCorpus: corpus }),
      'NAV-100',
      'src1',
      'KAN-42'
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record.meta).not.toHaveProperty('sourceUrl')
  })

  it('dedupes an unchanged re-attach instead of writing a second file', async () => {
    await attachCorpusEvidence(deps(), 'NAV-100', 'src1', 'KAN-42')
    const again = await attachCorpusEvidence(deps(), 'NAV-100', 'src1', 'KAN-42')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.deduped).toBe(true)
    expect(listEvidence(db, 'NAV-100')).toHaveLength(1)
  })

  it('writes a second snapshot when the record changed upstream', async () => {
    await attachCorpusEvidence(deps(), 'NAV-100', 'src1', 'KAN-42')
    const changed = {
      enabledSources: () => [{ id: 'src1', name: 'Hindsight', baseUrl: 'x' }],
      getDefect: async () => ({
        ok: true as const,
        value: record({ status: 'Reopened', resolution: null })
      })
    } as unknown as DefectCorpusService
    const res = await attachCorpusEvidence(
      deps({ defectCorpus: changed }),
      'NAV-100',
      'src1',
      'KAN-42'
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.deduped).toBe(false)
    expect(listEvidence(db, 'NAV-100')).toHaveLength(2)
  })

  it('refuses a traversal-shaped key before any fetch happens', async () => {
    let called = 0
    const corpus = {
      enabledSources: () => [],
      getDefect: async () => {
        called++
        return { ok: true as const, value: record() }
      }
    } as unknown as DefectCorpusService
    const res = await attachCorpusEvidence(
      deps({ defectCorpus: corpus }),
      'NAV-100',
      'src1',
      '../../escape'
    )
    expect(res).toMatchObject({ ok: false, code: 'invalid-key' })
    expect(called).toBe(0)
    expect(listEvidence(db, 'NAV-100')).toHaveLength(0)
  })

  it('reports a corpus failure instead of throwing, and writes nothing', async () => {
    const corpus = {
      enabledSources: () => [],
      getDefect: async () => ({ ok: false as const, error: 'corpus unreachable', code: 'network' })
    } as unknown as DefectCorpusService
    const res = await attachCorpusEvidence(
      deps({ defectCorpus: corpus }),
      'NAV-100',
      'src1',
      'KAN-42'
    )
    expect(res).toMatchObject({ ok: false, error: 'corpus unreachable', code: 'network' })
    expect(listEvidence(db, 'NAV-100')).toHaveLength(0)
  })

  it('reports an unknown case', async () => {
    const res = await attachCorpusEvidence(deps(), 'NOPE-1', 'src1', 'KAN-42')
    expect(res).toMatchObject({ ok: false, code: 'unknown-case' })
  })

  it('falls back to the source id when the source has no configured name', async () => {
    const corpus = {
      enabledSources: () => [],
      getDefect: async () => ({ ok: true as const, value: record() })
    } as unknown as DefectCorpusService
    const res = await attachCorpusEvidence(
      deps({ defectCorpus: corpus }),
      'NAV-100',
      'src1',
      'KAN-42'
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const onDisk = fs.readFileSync(path.join(home, 'cases', 'NAV-100', res.record.relPath), 'utf8')
    expect(onDisk).toContain('captured from the "src1" corpus')
  })
})
