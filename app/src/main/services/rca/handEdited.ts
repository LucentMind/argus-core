import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { RcaDraft, RcaDroppedSections } from '../../../shared/rca'
import type { CaseRcaInput } from '../../../shared/rca'
import { getCase } from '../caseService'
import { readReportMarkdown, structureFile } from './artifacts'
import { renderExecReport, renderTechReport, templateFromSnapshot, toIdSet } from './render'

export interface HandEditedDeps {
  db: DatabaseSync
  argusHome: string
}

interface ConfirmedRow {
  template_snapshot: string | null
  dropped_sections: string | null
  meta_snapshot: string | null
}

/** The drop set stored at confirm; a missing or malformed value means nothing was dropped —
 *  same posture as `templateFromSnapshot`, since a read must never fail on an older row. */
function storedDropped(raw: string | null): RcaDroppedSections {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as RcaDroppedSections
  } catch {
    return {}
  }
}

/**
 * The `caseMeta` snapshotted at confirm time, or `null` when the column is absent or malformed —
 * same read posture as `templateFromSnapshot`/`storedDropped`: this must never throw on a row an
 * older build wrote. Unlike those, there is no context-free default to fall back to here (there
 * is no "default case"), so the caller falls back to the LIVE case row instead. That fallback is
 * a DELIBERATE, bounded, self-healing wrong answer: it reproduces today's (pre-fix) behaviour,
 * which is correct whenever the case meta has not changed since confirm — the common case — and
 * wrong only for the specific defect this module exists to close. Reporting "not edited"
 * unconditionally for these rows instead would be an unbounded wrong answer: it would silently
 * lose real hand-edit detection for every case confirmed before this column shipped, forever.
 */
function metaFromSnapshot(raw: string | null): CaseRcaInput['caseMeta'] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as CaseRcaInput['caseMeta']
  } catch {
    return null
  }
}

/**
 * Whether each report's file differs from a fresh render of the confirmed structure, under the
 * job's snapshotted template AND the drop set recorded at confirm. Both inputs matter: rendering
 * under live settings, or without the drops, would make an untouched report read as edited.
 *
 * Anything that makes the comparison impossible — no confirmed job, missing artifacts, an
 * artifact read error other than ENOENT (EACCES/EBUSY/EISDIR — a file open in another editor is
 * routine on Windows), a structure file that is missing, unreadable, or valid JSON that is not a
 * conforming `RcaDraft` — reports "not edited" rather than throwing. This drives a warning
 * dialog, and warning about edits that may not exist is worse than staying quiet; the destructive
 * path (Confirm & freeze) rewrites the files from the structure either way.
 */
export function handEditedReports(
  deps: HandEditedDeps,
  slug: string
): { exec: boolean; tech: boolean } {
  const none = { exec: false, tech: false }
  const kase = getCase(deps.db, slug)
  if (!kase) return none

  const row = deps.db
    .prepare(
      `SELECT template_snapshot, dropped_sections, meta_snapshot FROM rca_jobs
       WHERE case_slug = ? AND confirmed_at IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(slug) as ConfirmedRow | undefined
  if (!row) return none

  // Everything from reading the artifacts through parsing the structure file and rendering must
  // degrade to "not edited": readReportMarkdown only swallows ENOENT itself, a structure file
  // can be valid JSON yet not a valid RcaDraft (external/hand corruption), and the renderers
  // assume a conforming draft — letting any of that throw here would break the documented
  // contract that an unreadable/unusable input reports "not edited" rather than crashing.
  try {
    const onDisk = readReportMarkdown(deps.argusHome, slug)
    if (!onDisk) return none

    const structure = JSON.parse(
      fs.readFileSync(structureFile(deps.argusHome, slug), 'utf8')
    ) as RcaDraft

    // The exact meta rendered at confirm — NOT the live case row, which may have moved since
    // (a Jira link, a rename). A pre-column row (meta_snapshot NULL/malformed) falls back to
    // live meta; see `metaFromSnapshot`'s doc for why that fallback is deliberate.
    const meta: CaseRcaInput['caseMeta'] = metaFromSnapshot(row.meta_snapshot) ?? {
      slug: kase.slug,
      title: kase.title,
      jiraKey: kase.jiraKey,
      resolution: kase.resolution,
      tags: kase.tags,
      createdAt: kase.createdAt,
      ticketProvider: kase.ticketProvider
    }
    const template = templateFromSnapshot(row.template_snapshot)
    const dropped = storedDropped(row.dropped_sections)
    return {
      exec:
        renderExecReport(structure, meta, { template, dropped: toIdSet(dropped.exec) }) !==
        onDisk.exec,
      tech:
        renderTechReport(structure, meta, { template, dropped: toIdSet(dropped.tech) }) !==
        onDisk.tech
    }
  } catch {
    return none
  }
}
