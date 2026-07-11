import fs from 'node:fs'
import path from 'node:path'
import {
  PACK_MANIFEST_FILE,
  packManifestSchema,
  type PackManifest
} from '../../../app/src/main/services/packs/manifest'

export function readManifest(packDir: string): PackManifest {
  const manifestPath = path.join(packDir, PACK_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`no ${PACK_MANIFEST_FILE} found in ${packDir}`)
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return packManifestSchema.parse(raw)
}
