import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactType, EvidenceRecord } from '../../shared/types'
import { ingestDerived } from './ingest'
import { caseDir } from './paths'

const execFileAsync = promisify(execFile)
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000

export const EXTRACTORS: Partial<Record<ArtifactType, 'binlog' | 'bintrace'>> = {
  binlog: 'binlog',
  bintrace: 'bintrace'
}

// Node refuses to execFile .bat/.cmd without a shell (CVE-2024-27980). Real
// binaries are .exe on win32 — only the test stubs hit this path.
function run(bin: string, args: string[]): Promise<unknown> {
  const isBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(bin)
  return execFileAsync(bin, args, { timeout: EXTRACT_TIMEOUT_MS, shell: isBatch })
}

export async function extractDerivedText(
  db: DatabaseSync,
  argusHome: string,
  rec: EvidenceRecord,
  bins: { argusParse: string | null }
): Promise<EvidenceRecord | null> {
  const kind = EXTRACTORS[rec.artifactType]
  if (!kind) return null
  const slugRow = db.prepare(`SELECT slug FROM cases WHERE id = ?`).get(rec.caseId) as
    { slug: string } | undefined
  if (!slugRow) return null
  const dir = caseDir(argusHome, slugRow.slug)
  const srcAbs = path.join(dir, rec.relPath)
  const derivedDir = path.join(dir, 'evidence', '.derived')
  fs.mkdirSync(derivedDir, { recursive: true })
  const outAbs = path.join(derivedDir, `${path.basename(rec.relPath)}.txt`)

  try {
    if (kind === 'binlog') {
      if (!bins.argusParse) {
        console.warn('[extraction] sample-parse unavailable — skipping BINLOG extraction')
        return null
      }
      await run(bins.argusParse, ['binlog-to-text', srcAbs, '--output', outAbs])
    } else {
      await run('sample-trace', ['convert-bintrace-to-text', srcAbs, '--output', outAbs])
    }
    return ingestDerived(db, argusHome, slugRow.slug, outAbs, rec.id)
  } catch (err) {
    console.warn(`[extraction] failed for ${rec.relPath}: ${(err as Error).message}`)
    return null
  }
}
