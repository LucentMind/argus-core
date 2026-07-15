import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'
import { OnboardingService, resolveSampleAssetsDir } from '../onboarding'
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

describe('resolveSampleAssetsDir', () => {
  let tmp2: string
  beforeEach(() => {
    tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-assets-'))
  })
  afterEach(() => fs.rmSync(tmp2, { recursive: true, force: true }))

  it('uses the packaged path only when it actually exists there', () => {
    const resources = path.join(tmp2, 'resources')
    fs.mkdirSync(path.join(resources, 'onboarding-sample'), { recursive: true })
    expect(resolveSampleAssetsDir(path.join(tmp2, 'app'), resources)).toBe(
      path.join(resources, 'onboarding-sample')
    )
  })

  it('falls back to <appRoot>/resources/onboarding-sample when resourcesPath lacks it (dev)', () => {
    // resourcesPath is set (as in dev, pointing at electron dist) but has no onboarding-sample
    const electronDist = path.join(tmp2, 'electron-dist', 'resources')
    fs.mkdirSync(electronDist, { recursive: true })
    const appRoot = path.join(tmp2, 'app')
    expect(resolveSampleAssetsDir(appRoot, electronDist)).toBe(
      path.join(appRoot, 'resources', 'onboarding-sample')
    )
  })

  it('falls back to the source dir when resourcesPath is undefined', () => {
    const appRoot = path.join(tmp2, 'app')
    expect(resolveSampleAssetsDir(appRoot, undefined)).toBe(
      path.join(appRoot, 'resources', 'onboarding-sample')
    )
  })
})
