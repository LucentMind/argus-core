import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { OnboardingService } from '../onboarding'
import { listCases } from '../caseService'
import { listEvidence } from '../ingest'
import { createDetection } from '../packs/detection'
import { samplePackRegistry } from '../packs/__tests__/fixtures'
import { SAMPLE_CASE_SLUG } from '../../../shared/onboarding'

let tmp: string
let argusHome: string
let assets: string
let db: DatabaseSync

const detection = createDetection(samplePackRegistry())

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-onb-'))
  argusHome = path.join(tmp, 'home')
  fs.mkdirSync(argusHome, { recursive: true })
  assets = path.join(tmp, 'assets')
  fs.mkdirSync(assets, { recursive: true })
  fs.writeFileSync(path.join(assets, 'sample-log.txt'), 'INFO boot ok\nWARN drift 3.2\n')
  db = openDb(path.join(argusHome, 'argus.db'))
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function svc(): OnboardingService {
  return new OnboardingService({
    db,
    argusHome,
    detection,
    sampleAssetsDir: assets,
    listCaseSlugs: () => listCases(db).map((c) => c.slug)
  })
}

describe('OnboardingService.seedSampleCase', () => {
  it('creates the sample case and ingests bundled evidence', () => {
    const r = svc().seedSampleCase()
    expect(r.slug).toBe(SAMPLE_CASE_SLUG)
    expect(r.evidenceIds.length).toBe(1)
    expect(listCases(db).some((c) => c.slug === SAMPLE_CASE_SLUG)).toBe(true)
  })

  it('is idempotent: second call does not create a duplicate case or evidence', () => {
    svc().seedSampleCase()
    svc().seedSampleCase()
    expect(listCases(db).filter((c) => c.slug === SAMPLE_CASE_SLUG).length).toBe(1)
    expect(listEvidence(db, SAMPLE_CASE_SLUG).length).toBe(1)
  })
})
