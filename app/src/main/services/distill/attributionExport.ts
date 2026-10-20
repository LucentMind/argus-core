import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { toAttributionEvent, type AttributionExportResult } from '../../../shared/attribution'
import { latestAttributionRows } from './attributions'

/** The alignment-meeting artifact until a central server exists (spec §4.9). Same mechanics as
 *  the eval export: nothing is uploaded; the write goes only where the save dialog pointed. */
export function exportAttributions(
  db: DatabaseSync,
  destPath: string,
  ctx: { installId: string; appVersion: string },
  opts: { domain?: string } = {}
): AttributionExportResult {
  const rows = latestAttributionRows(db).filter(
    (r) => opts.domain === undefined || r.caseDomain === opts.domain
  )
  const lines = rows.map((r) => JSON.stringify(toAttributionEvent(r, ctx)))
  fs.writeFileSync(destPath, lines.join('\n') + (lines.length ? '\n' : ''))
  return { path: destPath, exported: lines.length }
}
