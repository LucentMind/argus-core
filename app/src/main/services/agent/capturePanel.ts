import type { DatabaseSync } from 'node:sqlite'
import type { PanelHost } from '../panels/panelHost'
import type { Detection } from '../packs/detection'
import { ingestContent } from '../ingest'

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Filesystem-safe slug from a panel title; falls back to the windowId, then 'panel'. */
export function slugifyPanelTitle(title: string, fallback: string): string {
  return slug(title) || slug(fallback) || 'panel'
}

/** Compact UTC timestamp for filenames: 2026-07-14T15:30:12.123Z -> 20260714T153012Z. */
export function compactStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')
}

export type CapturePanelEvidence =
  | { ok: true; evidenceId: number; relPath: string; artifactType: string }
  | { ok: false; reason: string; hint?: string }

export interface CapturePanelDeps {
  panelHost: Pick<PanelHost, 'capturePanel'>
  db: DatabaseSync
  argusHome: string
  detection: Detection
  clock?: () => Date
}

/** Capture an open panel and register the PNG as case evidence (origin 'agent'). */
export async function capturePanelToEvidence(
  deps: CapturePanelDeps,
  caseSlug: string,
  packId: string,
  windowId: string
): Promise<CapturePanelEvidence> {
  const cap = await deps.panelHost.capturePanel({ caseSlug, packId, windowId })
  if (!cap.ok) return { ok: false, reason: cap.reason, hint: cap.hint }
  const stamp = compactStamp((deps.clock ?? (() => new Date()))())
  const fileName = `panel-${slugifyPanelTitle(cap.title, windowId)}-${stamp}.png`
  const rec = ingestContent(
    deps.db,
    deps.argusHome,
    deps.detection,
    caseSlug,
    fileName,
    cap.png,
    'agent',
    {
      packId,
      windowId,
      panelTitle: cap.title
    }
  )
  return { ok: true, evidenceId: rec.id, relPath: rec.relPath, artifactType: rec.artifactType }
}
