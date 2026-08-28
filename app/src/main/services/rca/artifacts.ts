import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { artifactsDir } from '../paths'
import { assertCaseWritable } from '../caseFreeze'

/**
 * The two rendered report artifacts. `post.ts` reads these files verbatim and sends their
 * bytes to Jira, so this module is the only place allowed to write them outside
 * `RcaJobs.confirm` — and it writes exactly what it is given, with no normalisation.
 *
 * The filenames are a closed set, never derived from caller input: `kind` is a union of two
 * literals rather than a filename, so no value crossing the IPC boundary can name a path.
 */
export type ReportKind = 'exec' | 'tech'

const FILENAME: Record<ReportKind, string> = {
  exec: 'rca-exec.md',
  tech: 'rca-tech.md'
}

export function reportFile(argusHome: string, slug: string, kind: ReportKind): string {
  return path.join(artifactsDir(argusHome, slug), FILENAME[kind])
}

/** The confirmed draft `RcaJobs.confirm` freezes alongside the two rendered reports. Named
 *  here rather than spelled out at each of its four read/write sites so the archive's
 *  "keep the RCA" rule and the writers cannot drift apart. */
export const RCA_STRUCTURE_FILE = 'rca-structure.json'

export function structureFile(argusHome: string, slug: string): string {
  return path.join(artifactsDir(argusHome, slug), RCA_STRUCTURE_FILE)
}

/** Every file in `artifacts/` that IS the RCA report — the closed set, derived from the same
 *  constants the writers use. `caseArchive` reads this to decide what survives archiving. */
export const RCA_REPORT_FILENAMES: readonly string[] = [
  RCA_STRUCTURE_FILE,
  ...Object.values(FILENAME)
]

/** Both reports, or null when the case has no confirmed report yet. Null is returned when
 *  EITHER file is missing: a half-written pair is not a report, and the editor must not open
 *  on one of them. */
export function readReportMarkdown(
  argusHome: string,
  slug: string
): { exec: string; tech: string } | null {
  try {
    return {
      exec: fs.readFileSync(reportFile(argusHome, slug, 'exec'), 'utf8'),
      tech: fs.readFileSync(reportFile(argusHome, slug, 'tech'), 'utf8')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Overwrites one report. Refuses when the case has no confirmed report — creating the file
 *  from nothing would leave a hand-written artifact with no structure behind it, which the
 *  hand-edited comparison could never resolve.
 *
 *  Takes `db` only for `assertCaseWritable`: a hand-edit saved while the case is being archived
 *  lands after the bundle is sealed and is then destroyed with the rest of `artifacts/`, and a
 *  hand-edit saved AFTER archiving leaves the report on disk disagreeing with the sealed copy
 *  a restore would put back. Both refuse. */
export function writeReportMarkdown(
  db: DatabaseSync,
  argusHome: string,
  slug: string,
  kind: ReportKind,
  body: string
): void {
  assertCaseWritable(db, slug)
  const file = reportFile(argusHome, slug, kind)
  if (!fs.existsSync(file)) throw new Error(`no confirmed RCA report for ${slug} to edit`)
  fs.writeFileSync(file, body)
}
