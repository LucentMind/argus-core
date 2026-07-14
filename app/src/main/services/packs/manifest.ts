import { z } from 'zod'

export const PACK_MANIFEST_FILE = 'argus-pack.json'

/** The pack-API contract version Core implements. Packs declare a compatible range via `argusApi`. */
export const PACK_API_VERSION = 1

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

const HEX = /^([0-9a-fA-F]{2})+$/

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
    names: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (n) => !['git', 'gh', 'rm', 'cd'].includes(n),
            'binary name collides with a risk-classified program'
          )
      )
      .min(1),
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

export const matchRuleSchema = z
  .object({
    nameEndsWith: z.array(z.string().min(1)).min(1).optional(),
    nameContains: z.array(z.string().min(1)).min(1).optional(),
    magicHex: z.string().regex(HEX, 'magicHex must be even-length hex').optional(),
    magicOffset: z.number().int().min(0).default(0),
    headRegex: z.object({ source: z.string().min(1), flags: z.string().default('') }).optional(),
    json: z
      .object({
        anyKeys: z.array(z.string().min(1)).optional(),
        arrayKeys: z.array(z.string().min(1)).optional()
      })
      .optional()
  })
  .passthrough()

export const packDetectorSchema = z
  .object({
    /** Pack-defined artifact type this detector assigns. */
    type: z.string().regex(KEBAB, 'artifact type must be kebab-case'),
    displayName: z.string().min(1).optional(),
    /** Skill the renderer's Analyze button suggests for this type. */
    analyzeSkill: z.string().min(1).optional(),
    /** Raw file is text — FTS-index it on ingest. */
    isText: z.boolean().default(false),
    /** OR of AND-rules; a file matching any rule gets this type. */
    match: z.array(matchRuleSchema).min(1),
    /** Derived-text extraction command; bin references a binaries[] id. */
    extract: z.object({ bin: z.string().min(1), args: z.array(z.string()).min(1) }).optional()
  })
  .passthrough()
  .transform((d) => ({ ...d, displayName: d.displayName ?? d.type }))

export type MatchRule = z.infer<typeof matchRuleSchema>
export type PackDetector = z.infer<typeof packDetectorSchema>

export const packWindowCommandSchema = z
  .object({
    id: z.string().regex(KEBAB, 'command id must be kebab-case'),
    title: z.string().min(1).optional(),
    /** What the command does + when the agent should call it — becomes the MCP tool's
     *  description. Falls back to `title`, then a generic string, when absent. */
    description: z.string().min(1).optional(),
    /** HITL risk, exactly like every other tool. */
    risk: z.enum(['low', 'medium', 'high']),
    /** Positional argument names; the agent tool exposes one string param each. */
    args: z.array(z.string().min(1)).default([]),
    /** Optional per-argument descriptions (arg name → text), applied to the tool's input schema. */
    argDescriptions: z.record(z.string().min(1), z.string().min(1)).optional()
  })
  .passthrough()

export type PackWindowCommand = z.infer<typeof packWindowCommandSchema>

export const packWindowSchema = z
  .object({
    id: z.string().regex(KEBAB, 'window id must be kebab-case'),
    /** 'webPanel' = sandboxed WebContentsView (3a/3b); 'externalApp' = spawned native process (3c). */
    kind: z.enum(['webPanel', 'externalApp']),
    /** Tab label / launcher entry / floated-window title. */
    title: z.string().min(1),
    /** HTML entry path, relative to the pack's ui/ dir. */
    entry: z.string().min(1),
    /** externalApp only: how Core drives the process. Only 'stdio' is implemented in 3c. */
    control: z.object({ channel: z.enum(['stdio']) }).optional(),
    /** externalApp only: 'node' → run `entry` with the app's bundled runtime (Electron-as-node),
     *  so a JS tool needs no build step. Absent ⇒ spawn `entry` directly as an executable. */
    runtime: z.enum(['node']).optional(),
    /** Artifact types (Part-1 detector `type`s) this panel renders → drives "Open in <panel>". */
    handles: z.array(z.string().min(1)).default([]),
    /** Docking hint; only 'tab' is honored in 3a. */
    placement: z.enum(['tab']).default('tab'),
    /** Allowed origins folded into the panel CSP; empty ⇒ bundle-assets-only. */
    network: z.array(z.string().min(1)).default([]),
    /** Verbs/protocols the window may use — read verbs (3a), write verbs (3b),
     *  case-file read protocol (3d-1). */
    permissions: z
      .array(
        z.enum([
          'getCaseContext',
          'requestEvidence',
          'readEvidence',
          'cite',
          'emitFinding',
          'sendToAgent',
          'readCaseFiles'
        ])
      )
      .default([]),
    /** Downstream commands → mcp__<pack>__<window>_<cmd> agent tools (3b-2). */
    commands: z.array(packWindowCommandSchema).default([])
  })
  .passthrough()

export type PackWindow = z.infer<typeof packWindowSchema>

export const packManifestSchema = z
  .object({
    id: z.string().regex(KEBAB, 'pack id must be kebab-case'),
    displayName: z.string().min(1),
    version: z.string().min(1),
    argusApi: z.string().min(1),
    /** Published-bundle target, '<os>-<arch>' (e.g. 'mac-arm64'). Stamped by `argus-pack build`; absent in dev source manifests. */
    platform: z
      .string()
      .regex(/^[a-z0-9]+-[a-z0-9]+$/, 'platform must be <os>-<arch>')
      .optional(),
    persona: z.string().min(1).optional(),
    binaries: z.array(packBinarySchema).default([]),
    detectors: z.array(packDetectorSchema).default([]),
    windows: z.array(packWindowSchema).default([]),
    /** Reference-sync routing seeds: keyword rules mapped to reference filenames. */
    referenceRouting: z
      .array(
        z.object({
          keywords: z.array(z.string().min(1)).min(1),
          target: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/, 'target must be a .md basename')
        })
      )
      .default([])
  })
  .passthrough()

export type PackManifest = z.infer<typeof packManifestSchema>
