import type { DatabaseSync } from 'node:sqlite'
import type { RelatedAttachResult } from '../../../shared/relatedHistory'
import type { Detection } from '../packs/detection'
import type { DefectCorpusService } from '../defectCorpus/service'
import { getCase } from '../caseService'
import { ingestBytes } from '../ingest'
import { evidenceFileNameFor, formatDefectSnapshot } from './snapshot'

export interface AttachDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  defectCorpus: DefectCorpusService
  /** Injected clock, per the main-process DI convention — the snapshot's
   *  `capturedAt` is part of its content, so a real clock would make every
   *  attach hash-unique and defeat the dedupe assertion in the tests. */
  now: () => string
}

/**
 * Freeze one corpus record into a case's evidence tree (spec §10).
 *
 * Keyed by `(caseSlug, sourceId, key)` and re-fetched here: the renderer never
 * supplies the bytes or the origin, so neither the file's content nor its
 * provenance label is under renderer control.
 *
 * Never throws — it mirrors `DefectCorpusService`'s result contract, because
 * every failure mode here (a dead corpus, a hostile key, an unknown case) is
 * something the explorer must render as a line of text rather than a dialog.
 */
export async function attachCorpusEvidence(
  deps: AttachDeps,
  caseSlug: string,
  sourceId: string,
  key: string
): Promise<RelatedAttachResult> {
  const kase = getCase(deps.db, caseSlug)
  if (!kase) return { ok: false, error: `Unknown case: ${caseSlug}`, code: 'unknown-case' }

  // Guard the key BEFORE the fetch: a hostile key must cost nothing and must
  // never reach a network call whose result we would then have to discard.
  let fileName: string
  try {
    fileName = evidenceFileNameFor(key)
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'invalid-key' }
  }

  const fetched = await deps.defectCorpus.getDefect(sourceId, key)
  if (!fetched.ok) return { ok: false, error: fetched.error, code: fetched.code }

  const sourceName =
    deps.defectCorpus.enabledSources().find((s) => s.id === sourceId)?.name ?? sourceId
  const markdown = formatDefectSnapshot(fetched.value, {
    sourceId,
    sourceName,
    capturedAt: deps.now()
  })

  const meta: Record<string, unknown> = { sourceId, defectKey: fetched.value.key }
  // Only an http(s) url is stored: `meta` is read back by UI that may render it,
  // and a stored `javascript:`/`file:` url is a guard waiting to be forgotten.
  if (/^https?:\/\//i.test(fetched.value.url)) meta.sourceUrl = fetched.value.url

  const { record, deduped } = ingestBytes(
    deps.db,
    deps.argusHome,
    deps.detection,
    caseSlug,
    fileName,
    Buffer.from(markdown, 'utf8'),
    'corpus',
    meta,
    kase.activeMode
  )
  return { ok: true, record, deduped }
}
