import { z } from './zodConfig'
import { INDEX_STATES, type CaseRecord } from './types'

/** .arguscase container format version. Import refuses bundles with format > BUNDLE_FORMAT. */
export const BUNDLE_FORMAT = 1

/** A linked repo captured at export time — checkouts are never copied (spec §2.1). */
export const bundleWorkspaceRefSchema = z.looseObject({
  remote: z.string().nullable(),
  branch: z.string().nullable(),
  commit: z.string().nullable()
})
export type BundleWorkspaceRef = z.infer<typeof bundleWorkspaceRefSchema>

/**
 * The bundle's row sidecar: the agent-run rows that live ONLY in the database and would
 * otherwise be destroyed by one archive/restore cycle.
 *
 * The bundle is otherwise files-only, so `turns`, `tool_calls` and the findings' session/turn
 * pointers had nowhere to travel: archiving deletes them, restore had nothing to rebuild them
 * from, and the tool-call audit trail (tool, risk, decision) plus every finding's "jump to
 * turn" deep-link died on the first round trip.
 *
 * The ids in here are the EXPORTING machine's autoincrements. They are carried so the rows can
 * be re-linked to each other on the far side, never re-used verbatim — `registerImportedSessions`
 * assigns fresh session ids, and the rebuild remaps turns, tool calls and finding pointers
 * through that one mapping.
 */
export const bundleRowsSchema = z.looseObject({
  turns: z
    .array(
      z.looseObject({
        id: z.number(),
        sessionId: z.number(),
        turnIndex: z.number(),
        status: z.string(),
        inputTokens: z.number().nullable().default(null),
        outputTokens: z.number().nullable().default(null),
        costUsd: z.number().nullable().default(null),
        durationMs: z.number().nullable().default(null),
        createdAt: z.string(),
        // Absent in every bundle written before rewind/fork existed — nullable with a null
        // default lets those old rows.json shapes keep parsing (see the bundleRowsSchema test
        // in shared/__tests__/bundle.test.ts).
        model: z.string().nullable().default(null),
        rewoundAt: z.string().nullable().default(null),
        rewoundToTurnId: z.number().nullable().default(null),
        providerAnchorId: z.string().nullable().default(null)
      })
    )
    .default([]),
  /**
   * Per-session metadata the archive rebuild otherwise has no way to restore:
   * `registerImportedSessions` re-creates sessions from the mirrored transcript JSONL alone,
   * which carries none of `driver_kind`/`instance_id`/`model`/`mode` or the fork-lineage
   * columns. Default `[]` because every bundle written before this field existed has none.
   */
  sessions: z
    .array(
      z.looseObject({
        id: z.number(),
        driverKind: z.string(),
        instanceId: z.string().nullable().default(null),
        model: z.string().nullable().default(null),
        mode: z.string(),
        forkedFromSessionId: z.number().nullable().default(null),
        forkedAtTurnId: z.number().nullable().default(null),
        forkedInheritedTurns: z.number().nullable().default(null)
      })
    )
    .default([]),
  toolCalls: z
    .array(
      z.looseObject({
        id: z.number(),
        sessionId: z.number(),
        turnId: z.number().nullable().default(null),
        tool: z.string(),
        argsHash: z.string(),
        risk: z.string(),
        decision: z.string(),
        durationMs: z.number().nullable().default(null),
        createdAt: z.string()
      })
    )
    .default([]),
  /**
   * The REAL index lifecycle state of every evidence row at export time, keyed by rel path.
   *
   * This is the only trustworthy record of it. The `.meta` sidecar on disk is written once at
   * INGEST time, when the row is still 'pending', and is never rewritten when the queue moves
   * the row to 'indexed' — so a restore reading the sidecars either resurrects a stale
   * 'pending' for every file (re-running the up-to-ten-minute extractor over all of them) or
   * guesses 'indexed' for every file, which buries a genuinely-pending extraction: the boot
   * sweep only re-queues pending/errored rows, so that file's pack extractor never runs again
   * and its derived evidence is lost for good.
   */
  evidence: z
    .array(
      z.looseObject({
        relPath: z.string(),
        // The lifecycle is a closed set (shared/types.ts); an unenumerated string would round-trip
        // verbatim into meta.indexState on restore and strand that row forever — it matches
        // neither the inline-index branch nor requeuePendingIndexes' pending/error sweep.
        indexState: z.enum(INDEX_STATES)
      })
    )
    .default([]),
  /** One entry per finding that pointed at a session/turn when the bundle was written. */
  findingPointers: z
    .array(
      z.looseObject({
        id: z.number(),
        sessionId: z.number().nullable().default(null),
        turnId: z.number().nullable().default(null)
      })
    )
    .default([])
})
export type BundleRows = z.infer<typeof bundleRowsSchema>

/** Fixed name of the row sidecar inside a bundle, beside `manifest.json`. */
export const BUNDLE_ROWS_FILE = 'rows.json'

export const bundleManifestSchema = z.looseObject({
  format: z.number().int().min(1),
  slug: z.string().min(1),
  title: z.string(),
  argusVersion: z.string(),
  createdAt: z.string(),
  includesTranscripts: z.boolean(),
  workspaces: z.array(bundleWorkspaceRefSchema).default([]),
  files: z.array(z.looseObject({ path: z.string().min(1), sha256: z.string(), size: z.number() })),
  /**
   * Integrity record for `rows.json`. Absent in every bundle written before the sidecar
   * existed AND in every ordinary user-facing export: only `archiveCase` asks for the sidecar
   * (`exportCase`'s `includeRows`), because only a restore into this same installation may
   * replay another machine's turn-by-turn token/cost record and its per-tool risk and
   * allow/deny verdicts. A shared bundle must not carry them, least of all when the user
   * unchecked "include transcripts".
   *
   * It lives in the manifest — rather than the sidecar being trusted on sight — so the sidecar
   * gets exactly the verification the case files get, and so `manifestHash` (the archive
   * identity digest) covers it too.
   */
  rows: z.looseObject({ sha256: z.string(), size: z.number() }).optional()
})
export type BundleManifest = z.infer<typeof bundleManifestSchema>

/** Renderer-facing summary returned by bundle:inspect (before the user confirms). */
export interface BundleInspection {
  zipPath: string
  manifest: BundleManifest
  proposedSlug: string
  collision: boolean
}

export type BundleExportResult =
  { ok: true; path: string; fileCount: number } | { ok: false; error: string }
export type BundleInspectResult =
  { ok: true; inspection: BundleInspection } | { ok: false; error: string }
export type BundleImportResult = { ok: true; record: CaseRecord } | { ok: false; error: string }
