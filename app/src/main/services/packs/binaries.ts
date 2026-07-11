import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { PackBinary } from './manifest'

export type BinarySource = 'env' | 'settings' | 'pack-dev' | 'bundled' | 'path'

export interface ResolvedBinary {
  decl: PackBinary
  packDir: string
  value: string | null
  source: BinarySource | null
}

export interface ResolveCtx {
  packDir: string
  /**
   * USER-set env value for decl.envVar, captured by the caller at startup —
   * deliberately no process.env default: the app exports resolved values back
   * into its own env for spawned children, and a live read here would let
   * that export shadow settings (the parsers.ts footgun this design removes).
   */
  envValue: string | null
  settingsValue: string | undefined
  resourcesPath?: string
}

function platformBin(): string {
  return process.platform === 'win32' ? 'Scripts' : 'bin'
}

function exeCandidates(name: string): string[] {
  return process.platform === 'win32' ? [`${name}.exe`, name] : [name, `${name}.exe`]
}

export function firstExistingExe(dir: string, names: string[]): string | null {
  for (const name of names) {
    for (const cand of exeCandidates(name)) {
      const p = path.join(dir, cand)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

export function resolveBinary(decl: PackBinary, ctx: ResolveCtx): ResolvedBinary {
  const found = (value: string | null, source: BinarySource | null): ResolvedBinary => ({
    decl, packDir: ctx.packDir, value, source
  })

  if (ctx.envValue && fs.existsSync(ctx.envValue)) return found(ctx.envValue, 'env')
  if (ctx.settingsValue && fs.existsSync(ctx.settingsValue)) return found(ctx.settingsValue, 'settings')

  const devDirs = decl.devPaths.map((p) =>
    path.resolve(ctx.packDir, p.replaceAll('{platformBin}', platformBin()))
  )

  if (decl.kind === 'pathDir') {
    for (const d of devDirs) if (fs.existsSync(d)) return found(d, 'pack-dev')
    return found(null, null)
  }

  for (const d of devDirs) {
    const hit = firstExistingExe(d, decl.names)
    if (hit) return found(hit, 'pack-dev')
  }
  if (ctx.resourcesPath) {
    const hit = firstExistingExe(path.join(ctx.resourcesPath, 'bin'), decl.names)
    if (hit) return found(hit, 'bundled')
  }
  if (decl.pathProbeArgs) {
    try {
      execFileSync(decl.names[0], decl.pathProbeArgs, { stdio: 'ignore', timeout: 3000 })
      return found(decl.names[0], 'path')
    } catch {
      /* fall through */
    }
  }
  return found(null, null)
}
