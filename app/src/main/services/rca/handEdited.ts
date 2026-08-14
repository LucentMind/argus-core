import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { RcaDraft, RcaDroppedSections } from '../../../shared/rca'
import type { CaseRcaInput } from '../../../shared/rca'
import { getCase } from '../caseService'
import { artifactsDir } from '../paths'
import { readReportMarkdown } from './artifacts'
import { renderExecReport, renderTechReport, templateFromSnapshot, toIdSet } from './render'

export interface HandEditedDeps {
  db: DatabaseSync
  argusHome: string
}

interface ConfirmedRow {
  template_snapshot: string | null
  dropped_sections: string | null
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
 * Whether each report's file differs from a fresh render of the confirmed structure, under the
 * job's snapshotted template AND the drop set recorded at confirm. Both inputs matter: rendering
 * under live settings, or without the drops, would make an untouched report read as edited.
 *
 * Anything that makes the comparison impossible — no confirmed job, missing artifacts, an
 * unreadable structure file — reports "not edited". This drives a warning dialog, and warning
 * about edits that may not exist is worse than staying quiet; the destructive path (Confirm &
 * freeze) rewrites the files from the structure either way.
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
      `SELECT template_snapshot, dropped_sections FROM rca_jobs
       WHERE case_slug = ? AND confirmed_at IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(slug) as ConfirmedRow | undefined
  if (!row) return none

  const onDisk = readReportMarkdown(deps.argusHome, slug)
  if (!onDisk) return none

  let structure: RcaDraft
  try {
    structure = JSON.parse(
      fs.readFileSync(path.join(artifactsDir(deps.argusHome, slug), 'rca-structure.json'), 'utf8')
    ) as RcaDraft
  } catch {
    return none
  }

  const meta: CaseRcaInput['caseMeta'] = {
    slug: kase.slug,
    title: kase.title,
    jiraKey: kase.jiraKey,
    resolution: kase.resolution,
    tags: kase.tags,
    createdAt: kase.createdAt
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
}
