import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createCase } from '../../caseService'
import { ingestArtifact } from '../../ingest'
import { createDetection } from '../../packs/detection'
import type { CaseRecord } from '../../../../shared/types'
import { createImmediateQueue } from '../../ingestQueue'

const FIXTURES = path.resolve(__dirname, '../../../../../../tests/fixtures')

/** Seeds the spec §1.6 fixture pair: two cases sharing one defect signature. */
export async function seedMemoryPair(
  db: DatabaseSync,
  argusHome: string
): Promise<{ a: CaseRecord; b: CaseRecord }> {
  const detection = createDetection()
  const a = createCase(db, argusHome, {
    slug: 'NAV-100',
    title: 'Tile region fails on OEM head unit'
  })
  const b = createCase(db, argusHome, {
    slug: 'NAV-200',
    title: 'Offline routing broken after tiles update'
  })
  await ingestArtifact(
    db,
    argusHome,
    detection,
    createImmediateQueue(db, argusHome),
    'NAV-100',
    path.join(FIXTURES, 'memory-pair-a-applog.txt')
  )
  await ingestArtifact(
    db,
    argusHome,
    detection,
    createImmediateQueue(db, argusHome),
    'NAV-200',
    path.join(FIXTURES, 'memory-pair-b-applog.txt')
  )
  return { a, b }
}
