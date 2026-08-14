import fs from 'node:fs'
import path from 'node:path'
import { artifactsDir } from '../paths'

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
 *  hand-edited comparison could never resolve. */
export function writeReportMarkdown(
  argusHome: string,
  slug: string,
  kind: ReportKind,
  body: string
): void {
  const file = reportFile(argusHome, slug, kind)
  if (!fs.existsSync(file)) throw new Error(`no confirmed RCA report for ${slug} to edit`)
  fs.writeFileSync(file, body)
}
