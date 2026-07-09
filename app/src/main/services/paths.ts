import os from 'node:os'
import path from 'node:path'

export function resolveArgusHome(): string {
  return process.env.ARGUS_HOME ?? path.join(os.homedir(), 'Argus')
}

export function dbPath(argusHome: string): string {
  return path.join(argusHome, 'argus.db')
}

export function caseDir(argusHome: string, slug: string): string {
  return path.join(argusHome, 'cases', slug)
}
