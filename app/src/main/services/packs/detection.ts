import fs from 'node:fs'
import path from 'node:path'
import type { ArtifactTypeMeta } from '../../../shared/types'
import type { MatchRule, PackDetector } from './manifest'
import type { PackRegistry } from './registry'

const HEAD_BYTES = 8192

export interface Detection {
  detectType(filePath: string): string
  isText(type: string): boolean
  compoundExts(): string[]
  artifactMeta(): ArtifactTypeMeta[]
}

interface CompiledRule {
  nameEndsWith?: string[]
  nameContains?: string[]
  magic?: { bytes: Buffer; offset: number }
  headRegex?: RegExp
  json?: { anyKeys: string[]; arrayKeys: string[] }
}

interface CompiledDetector {
  decl: PackDetector
  rules: CompiledRule[]
}

function compileRule(type: string, r: MatchRule): CompiledRule | null {
  try {
    const c: CompiledRule = {}
    if (r.nameEndsWith) c.nameEndsWith = r.nameEndsWith.map((s) => s.toLowerCase())
    if (r.nameContains) c.nameContains = r.nameContains.map((s) => s.toLowerCase())
    if (r.magicHex) c.magic = { bytes: Buffer.from(r.magicHex, 'hex'), offset: r.magicOffset }
    if (r.headRegex) c.headRegex = new RegExp(r.headRegex.source, r.headRegex.flags)
    if (r.json) c.json = { anyKeys: r.json.anyKeys ?? [], arrayKeys: r.json.arrayKeys ?? [] }
    if (Object.keys(c).length === 0) return null
    return c
  } catch (err) {
    console.warn(`[packs] detector '${type}': bad match rule skipped: ${(err as Error).message}`)
    return null
  }
}

export function compileDetectors(decls: PackDetector[]): CompiledDetector[] {
  return decls
    .map((decl) => ({
      decl,
      rules: decl.match
        .map((r) => compileRule(decl.type, r))
        .filter((r): r is CompiledRule => r != null)
    }))
    .filter((d) => d.rules.length > 0)
}

function readHead(filePath: string, bytes = HEAD_BYTES): Buffer {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

interface FileFacts {
  name: string // lowercased basename
  head: Buffer
  headText: string | null // null when head contains NUL bytes
  jsonValue?: unknown // lazily parsed, cached (undefined = not tried, null = parse failed)
}

function ruleMatches(rule: CompiledRule, filePath: string, facts: FileFacts): boolean {
  if (rule.nameEndsWith && !rule.nameEndsWith.some((s) => facts.name.endsWith(s))) return false
  if (rule.nameContains && !rule.nameContains.some((s) => facts.name.includes(s))) return false
  if (rule.magic) {
    const { bytes, offset } = rule.magic
    if (facts.head.length < offset + bytes.length) return false
    if (!facts.head.subarray(offset, offset + bytes.length).equals(bytes)) return false
  }
  if (rule.headRegex) {
    if (facts.headText == null || !rule.headRegex.test(facts.headText)) return false
  }
  if (rule.json) {
    if (facts.jsonValue === undefined) {
      try {
        facts.jsonValue = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      } catch {
        facts.jsonValue = null
      }
    }
    const v = facts.jsonValue
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    if (rule.json.anyKeys.length && !rule.json.anyKeys.some((k) => k in o)) return false
    if (rule.json.arrayKeys.length && !rule.json.arrayKeys.every((k) => Array.isArray(o[k])))
      return false
  }
  return true
}

const GENERIC_META: ArtifactTypeMeta[] = [
  { type: 'archive', displayName: 'archive', analyzeSkill: null, isText: false },
  { type: 'screenshot', displayName: 'screenshot', analyzeSkill: null, isText: false },
  { type: 'text', displayName: 'text', analyzeSkill: null, isText: true },
  { type: 'unknown', displayName: 'unknown', analyzeSkill: null, isText: false }
]

function genericType(facts: FileFacts): string {
  const h = facts.head
  if (h.length >= 2 && h[0] === 0x1f && h[1] === 0x8b) return 'archive' // gzip
  if (h.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'archive' // zip
  if (h.length > 262 && h.subarray(257, 262).equals(Buffer.from('ustar', 'latin1')))
    return 'archive'
  if (h.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'screenshot' // png
  if (h.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'screenshot' // jpeg
  return facts.headText != null ? 'text' : 'unknown'
}

export function createDetection(registry?: PackRegistry): Detection {
  const compiled = compileDetectors(registry?.detectorDecls() ?? [])
  const textTypes = new Set([
    'text',
    ...compiled.filter((d) => d.decl.isText).map((d) => d.decl.type)
  ])
  const exts = new Set(['.tar.gz'])
  for (const d of compiled) {
    for (const r of d.decl.match) {
      for (const s of r.nameEndsWith ?? []) {
        if (s.split('.').length > 2) exts.add(s.toLowerCase()) // '.rec.gz' → ['', 'rec', 'gz']
      }
    }
  }

  return {
    detectType(filePath: string): string {
      const head = readHead(filePath)
      const facts: FileFacts = {
        name: path.basename(filePath).toLowerCase(),
        head,
        headText: head.includes(0) ? null : head.toString('utf8')
      }
      for (const d of compiled) {
        if (d.rules.some((r) => ruleMatches(r, filePath, facts))) return d.decl.type
      }
      return genericType(facts)
    },
    isText: (type) => textTypes.has(type),
    compoundExts: () => [...exts],
    artifactMeta: () => [
      ...compiled.map((d) => ({
        type: d.decl.type,
        displayName: d.decl.displayName || d.decl.type,
        analyzeSkill: d.decl.analyzeSkill ?? null,
        isText: d.decl.isText
      })),
      ...GENERIC_META
    ]
  }
}
