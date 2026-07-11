import { z } from 'zod'

export const PACK_MANIFEST_FILE = 'argus-pack.json'

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const packBinarySchema = z
  .object({
    id: z.string().regex(KEBAB, 'binary id must be kebab-case'),
    /** 'exe' = a single executable; 'pathDir' = a directory prepended to PATH. */
    kind: z.enum(['exe', 'pathDir']),
    displayName: z.string().min(1),
    description: z.string().default(''),
    /** User env override; captured at startup and (exe) exported to spawned children. */
    envVar: z.string().min(1).optional(),
    /** Key under settings.tools holding a user path override. */
    settingsKey: z.string().min(1).optional(),
    /** Executable base names (platform .exe variants handled by the resolver). */
    names: z.array(z.string().min(1)).min(1),
    /** Dev-checkout locations, relative to the pack dir; '{platformBin}' → Scripts|bin. */
    devPaths: z.array(z.string()).default([]),
    /** exe: args that print a version string when run against the resolved binary. */
    versionArgs: z.array(z.string()).optional(),
    /** exe: last-resort bare-name-on-PATH probe; the command must exit 0. */
    pathProbeArgs: z.array(z.string()).optional(),
    /** pathDir: health/preflight doctor. json=true → stdout is a PreflightReport (pack API contract). */
    doctor: z
      .object({
        cmd: z.string().min(1),
        args: z.array(z.string()).default([]),
        json: z.boolean().default(false)
      })
      .optional(),
    /** Shown when the binary is missing (health fix hint / preflight detail). */
    fixHint: z.string().default(''),
    /** When set, the binary only applies on these platforms (process.platform values). */
    platforms: z.array(z.enum(['win32', 'darwin', 'linux'])).optional()
  })
  .passthrough()

export type PackBinary = z.infer<typeof packBinarySchema>

export const packManifestSchema = z
  .object({
    id: z.string().regex(KEBAB, 'pack id must be kebab-case'),
    displayName: z.string().min(1),
    version: z.string().min(1),
    argusApi: z.string().min(1),
    persona: z.string().min(1).optional(),
    binaries: z.array(packBinarySchema).default([])
  })
  .passthrough()

export type PackManifest = z.infer<typeof packManifestSchema>
