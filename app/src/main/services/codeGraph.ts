import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function graphsRoot(argusHome: string): string {
  return path.join(argusHome, 'graphs')
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Stable cache identity: remote owner/name when known, else basename + path hash. */
export function repoIdFor(repoPath: string, remote: string | null): string {
  if (remote) {
    const tail = remote
      .replace(/\.git$/i, '')
      .split(/[/:]/)
      .filter(Boolean)
      .slice(-2)
      .join('-')
    if (tail) return slug(tail)
  }
  const hash = crypto.createHash('sha1').update(path.resolve(repoPath)).digest('hex').slice(0, 8)
  return `${slug(path.basename(repoPath))}-${hash}`
}

/** '_root' for whole-repo; else a slug of the RELATIVE subpath. Rejects escapes. */
export function scopeKeyFor(scope: string | null): string {
  if (scope == null) return '_root'
  const trimmed = scope.trim().replace(/[\\/]+$/, '')
  if (!trimmed) throw new Error('scope must be a non-empty relative path')
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed))
    throw new Error('scope must be relative to the repo root')
  const parts = trimmed.split(/[\\/]+/)
  if (parts.some((p) => p === '..')) throw new Error('scope must not escape the repo')
  return slug(parts.join('-'))
}

export function graphCacheDir(argusHome: string, repoId: string, scopeKey: string): string {
  return path.join(graphsRoot(argusHome), repoId, scopeKey)
}

export interface GraphMeta {
  commit: string
  branch: string
  scope: string | null
  builtAt: string
  graphifyVersion: string | null
  nodeCount: number | null
  edgeCount: number | null
  status: 'ok' | 'failed'
  error?: string
}

export function readMeta(cacheDir: string): GraphMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8')) as GraphMeta
  } catch {
    return null
  }
}

export function writeMeta(cacheDir: string, meta: GraphMeta): void {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2))
}

/** graphify extract prints: "... wrote <path>/graph.json: N nodes, M edges, K communities" */
export function parseExtractCounts(stdout: string): { nodes: number | null; edges: number | null } {
  const m = /graph\.json:\s*(\d+) nodes, (\d+) edges/.exec(stdout)
  return m ? { nodes: Number(m[1]), edges: Number(m[2]) } : { nodes: null, edges: null }
}
