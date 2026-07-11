import { z } from 'zod'

export const PACK_MANIFEST_FILE = 'argus-pack.json'

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const packManifestSchema = z
  .object({
    id: z.string().regex(KEBAB, 'pack id must be kebab-case'),
    displayName: z.string().min(1),
    version: z.string().min(1),
    argusApi: z.string().min(1),
    persona: z.string().min(1).optional()
  })
  .passthrough()

export type PackManifest = z.infer<typeof packManifestSchema>
