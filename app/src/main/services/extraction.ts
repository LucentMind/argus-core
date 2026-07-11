import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { EvidenceRecord } from '../../shared/types'
import type { Extractors } from './packs/extractors'
import { ingestDerived } from './ingest'
import { caseDir } from './paths'

const execFileAsync = promisify(execFile)
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000

// Node refuses to execFile .bat/.cmd without a shell (CVE-2024-27980). Real
// binaries are .exe on win32 — only the test stubs hit this path.
function run(bin: string, args: string[]): Promise<unknown> {
  const isBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(bin)
  return execFileAsync(bin, args, { timeout: EXTRACT_TIMEOUT_MS, shell: isBatch })
}

/** Run the pack-declared extract command for rec's type; '{input}'/'{output}' are substituted. */
export async function extractDerivedText(
  db: DatabaseSync,
  argusHome: string,
  rec: EvidenceRecord,
  extractors: Extractors
): Promise<EvidenceRecord | null> {
  const extract = extractors.extractFor(rec.artifactType)
  if (!extract) return null
  const slugRow = db.prepare(`SELECT slug FROM cases WHERE id = ?`).get(rec.caseId) as
    { slug: string } | undefined
  if (!slugRow) return null
  const dir = caseDir(argusHome, slugRow.slug)
  const srcAbs = path.join(dir, rec.relPath)
  const derivedDir = path.join(dir, 'evidence', '.derived')
  fs.mkdirSync(derivedDir, { recursive: true })
  const outAbs = path.join(derivedDir, `${path.basename(rec.relPath)}.txt`)

  try {
    const args = extract.args.map((a) => a.replaceAll('{input}', srcAbs).replaceAll('{output}', outAbs))
    await run(extract.command, args)
    return ingestDerived(db, argusHome, slugRow.slug, outAbs, rec.id)
  } catch (err) {
    console.warn(`[extraction] failed for ${rec.relPath}: ${(err as Error).message}`)
    return null
  }
}
