import { z } from 'zod'
import type { CaseRecord } from './types'

/** .arguscase container format version. Import refuses bundles with format > BUNDLE_FORMAT. */
export const BUNDLE_FORMAT = 1

/** A linked repo captured at export time — checkouts are never copied (spec §2.1). */
export const bundleWorkspaceRefSchema = z.looseObject({
  remote: z.string().nullable(),
  branch: z.string().nullable(),
  commit: z.string().nullable()
})
export type BundleWorkspaceRef = z.infer<typeof bundleWorkspaceRefSchema>

export const bundleManifestSchema = z.looseObject({
  format: z.number().int().min(1),
  slug: z.string().min(1),
  title: z.string(),
  argusVersion: z.string(),
  createdAt: z.string(),
  includesTranscripts: z.boolean(),
  workspaces: z.array(bundleWorkspaceRefSchema).default([]),
  files: z.array(z.looseObject({ path: z.string().min(1), sha256: z.string(), size: z.number() }))
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
