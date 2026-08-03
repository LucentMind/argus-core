import { z } from './zodConfig'

/**
 * Type-only re-exports so preload (and any other cross-process consumer) never reaches
 * into `main/services/*` directly — same rule that put `DiagnosticsSnapshot` in
 * `shared/diagnostics.ts` for the diagnostics IPC wiring (see git show cddc924f). The
 * runtime code (zod schemas, DefectCorpusService) stays put in main/services/defectCorpus;
 * this file only re-exports the shapes preload's `defects` namespace needs.
 */
export type {
  CorpusAdminConfig,
  CorpusInfo,
  CorpusJqlPreview,
  CorpusSearchInput,
  CorpusSyncStatus
} from '../main/services/defectCorpus/client'
export type { CorpusAdminResult, SourceSearchResult } from '../main/services/defectCorpus/service'

/**
 * One configured Defect Corpus HTTP source (`settings.defectCorpus.sources[id]`).
 * Consumed by the vendored client (`main/services/defectCorpus/client.ts`, Task 1)
 * and, in later tasks, the service manager / IPC / UI layers.
 */
export const defectCorpusSourceSchema = z.looseObject({
  name: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean()
})
export type DefectCorpusSourceCfg = z.infer<typeof defectCorpusSourceSchema>

/** `settings.defectCorpus` section: keyed by source id, default {} (no sources configured). */
export const defectCorpusSchema = z.looseObject({
  sources: z.record(z.string(), defectCorpusSourceSchema).default(() => ({}))
})

/** safeStorage secret name for a configured source's API token, keyed by source id. */
export const corpusTokenSecret = (id: string): string => `defectCorpus/${id}/token`
