import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createCase } from './caseService'
import { ingestArtifact, listEvidence } from './ingest'
import type { Detection } from './packs/detection'
import {
  SAMPLE_CASE_SLUG,
  SAMPLE_CASE_TITLE,
  SAMPLE_EVIDENCE_FILES,
  type SeedSampleResult
} from '../../shared/onboarding'

/**
 * Resolve the bundled onboarding-sample assets directory. Mirrors
 * `seededPacksDir`: `process.resourcesPath` is set even in dev (it points at
 * Electron's OWN dist resources, e.g. node_modules/electron/dist/resources),
 * so we must existence-check the packaged path before trusting it and fall back
 * to the in-repo source dir otherwise.
 *
 * - Packaged: `<resourcesPath>/onboarding-sample` (electron-builder extraResources).
 * - Dev / source: `<appRoot>/resources/onboarding-sample`.
 */
export function resolveSampleAssetsDir(appRoot: string, resourcesPath?: string): string {
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'onboarding-sample')
    if (fs.existsSync(packaged)) return packaged
  }
  return path.join(appRoot, 'resources', 'onboarding-sample')
}

export interface OnboardingDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  /** Directory holding SAMPLE_EVIDENCE_FILES (packaged: <resources>/onboarding-sample). */
  sampleAssetsDir: string
  listCaseSlugs: () => string[]
}

export class OnboardingService {
  constructor(private deps: OnboardingDeps) {}

  /**
   * Create the sample case + ingest bundled evidence. Idempotent by slug: if
   * the case already exists, this returns its slug and current evidence ids
   * without re-creating the case or re-ingesting evidence (ingestArtifact
   * writes a collision-free copy on every call rather than erroring on a
   * duplicate, so re-running the ingest loop would otherwise pile up copies).
   */
  seedSampleCase(): SeedSampleResult {
    const { db, argusHome, detection, sampleAssetsDir, listCaseSlugs } = this.deps
    const exists = listCaseSlugs().includes(SAMPLE_CASE_SLUG)
    if (exists) {
      return {
        slug: SAMPLE_CASE_SLUG,
        evidenceIds: listEvidence(db, SAMPLE_CASE_SLUG).map((e) => e.id)
      }
    }

    createCase(db, argusHome, { slug: SAMPLE_CASE_SLUG, title: SAMPLE_CASE_TITLE })
    const evidenceIds: number[] = []
    for (const file of SAMPLE_EVIDENCE_FILES) {
      const abs = path.join(sampleAssetsDir, file)
      const rec = ingestArtifact(db, argusHome, detection, SAMPLE_CASE_SLUG, abs)
      evidenceIds.push(rec.id)
    }
    return { slug: SAMPLE_CASE_SLUG, evidenceIds }
  }
}
