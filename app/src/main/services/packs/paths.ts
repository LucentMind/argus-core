import fs from 'node:fs'
import path from 'node:path'

export function packsDir(argusHome: string): string {
  return process.env.ARGUS_PACKS_DIR ?? path.join(argusHome, 'packs')
}

/** Dev default: repo-root packs/ next to app/. Overridable via ARGUS_PACKS_SRC. */
export function resolvePacksSource(appRoot: string): string {
  return process.env.ARGUS_PACKS_SRC ?? path.resolve(appRoot, '..', 'packs')
}

export function seedPacks(argusHome: string, source: string): void {
  const dest = packsDir(argusHome)
  if (fs.existsSync(source) && path.resolve(source) !== path.resolve(dest)) {
    fs.cpSync(source, dest, { recursive: true, force: true })
  } else {
    fs.mkdirSync(dest, { recursive: true })
  }
}
