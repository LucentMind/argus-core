import path from 'node:path'
import type { ToolTaxonomy } from './risk'

export interface ToolDetailCtx {
  taxonomy: ToolTaxonomy
  referencesDir: string
  caseDir: string
}

/** Bound stored detail so a pathological input can't bloat the audit table. */
const MAX_DETAIL = 256

/**
 * Usage-stats capture (spec §1): the queryable "which one" behind a tool_calls row.
 * - `Skill` → skill name, `argus:` plugin prefix stripped to match skillsResolver names.
 * - argus memory tools → topic name.
 * - taxonomy fs-reads whose path lands inside the shared references dir → `ref:<relpath>`.
 * Total function: anything unexpected → null. Must never throw — it sits on the
 * tool-approval path.
 */
export function extractToolDetail(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolDetailCtx
): string | null {
  try {
    if (toolName === 'Skill') {
      const s = input.skill
      if (typeof s !== 'string' || !s.trim()) return null
      return s
        .trim()
        .replace(/^argus:/, '')
        .slice(0, MAX_DETAIL)
    }
    if (toolName === 'mcp__argus__read_memory' || toolName === 'mcp__argus__write_memory') {
      const t = input.topic
      return typeof t === 'string' && t.trim() ? t.trim().slice(0, MAX_DETAIL) : null
    }
    const entry = ctx.taxonomy.entries[toolName]
    if (entry && entry.kind === 'fs-read') {
      for (const f of entry.pathFields ?? []) {
        const v = input[f]
        if (typeof v !== 'string' || !v.trim()) continue
        const abs = path.resolve(ctx.caseDir, v)
        const root = path.resolve(ctx.referencesDir)
        // NTFS is case-insensitive; a raw string compare here silently drops attribution
        // when input casing drifts from the stored referencesDir (e.g. lowercase drive
        // letter). Windows-only: POSIX filesystems are genuinely case-sensitive.
        const cmpAbs = process.platform === 'win32' ? abs.toLowerCase() : abs
        const cmpRoot = process.platform === 'win32' ? root.toLowerCase() : root
        if (cmpAbs !== cmpRoot && cmpAbs.startsWith(cmpRoot + path.sep)) {
          const rel = path.relative(root, abs).split(path.sep).join('/')
          return `ref:${rel}`.slice(0, MAX_DETAIL)
        }
        break // first present path field decides; a non-reference read is just null
      }
    }
    return null
  } catch {
    return null
  }
}
