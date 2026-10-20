// app/src/shared/attribution.ts
import type { CaseOutcome } from './caseOutcome'
import type { DossierCite } from './distillV3'

export type AssetKind = 'skill' | 'reference' | 'memory'
export const ASSET_KINDS: readonly AssetKind[] = ['skill', 'reference', 'memory']

export interface AssetInventoryEntry {
  kind: AssetKind
  name: string
  tier: string | null
  callCount: number
  firstSeen: { sessionId: number; turnId: number | null }
}

/** Inventory cap (spec §4.4): the prompt lists the top N by callCount in full, the rest by name only. */
export const MAX_INVENTORY_ITEMS = 40

export type AssetVerdictValue = 'helped' | 'neutral' | 'misled'
export const ASSET_VERDICTS: readonly AssetVerdictValue[] = ['helped', 'neutral', 'misled']

export interface AssetVerdict {
  kind: AssetKind
  name: string
  /** null = the judge was silent about an inventoried asset. */
  applied: boolean | null
  verdict: AssetVerdictValue | null
  reason: string
  cites: DossierCite[]
}

export interface AttributionOutput {
  verdicts: AssetVerdict[]
  malformedDropped: Record<string, number>
  unknownAssetDropped: Record<string, number>
  uncitedDropped: number
  duplicateDropped: number
}

export type OverrideSource = 'finding-retraction' | 'proposal-reject'

export interface AttributionRow {
  id: number
  caseId: number
  caseSlug: string
  jobId: number
  assetKind: AssetKind
  assetName: string
  assetTier: string | null
  applied: boolean | null
  verdict: AssetVerdictValue | null
  reason: string
  cites: DossierCite[]
  caseOutcome: CaseOutcome
  caseDomain: string
  judgeModel: string
  promptHash: string
  overrideVerdict: AssetVerdictValue | null
  overrideSource: OverrideSource | null
  overrideAt: string | null
  createdAt: string
}

export const MIN_APPLIED = 3

export interface DomainUsefulness {
  applied: number
  helped: number
  neutral: number
  misled: number
  outcomes: Partial<Record<CaseOutcome, number>>
}

export interface AssetUsefulness {
  kind: AssetKind
  name: string
  tier: string | null
  applied: number
  helped: number
  neutral: number
  misled: number
  silent: number
  /** helped / (helped + neutral + misled); null under MIN_APPLIED. */
  helpedRate: number | null
  byDomain: Record<string, DomainUsefulness>
  /** Domains where helped > misled and applied ≥ MIN_APPLIED. Computed, never written to the asset. */
  emergentDomains: string[]
  outcomes: Partial<Record<CaseOutcome, number>>
  lastAppliedAt: string | null
}

export function effectiveVerdict(
  r: Pick<AttributionRow, 'verdict' | 'overrideVerdict'>
): AssetVerdictValue | null {
  return r.overrideVerdict ?? r.verdict
}

const bump = <K extends string>(o: Partial<Record<K, number>>, k: K): void => {
  o[k] = (o[k] ?? 0) + 1
}

export function aggregateAttributions(rows: AttributionRow[]): AssetUsefulness[] {
  const byAsset = new Map<string, { rows: AttributionRow[] }>()
  for (const r of rows) {
    const key = `${r.assetKind}/${r.assetName}`
    const cur = byAsset.get(key)
    if (cur) cur.rows.push(r)
    else byAsset.set(key, { rows: [r] })
  }
  const out: AssetUsefulness[] = []
  for (const { rows: group } of byAsset.values()) {
    const newest = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    const u: AssetUsefulness = {
      kind: newest.assetKind,
      name: newest.assetName,
      tier: newest.assetTier,
      applied: 0,
      helped: 0,
      neutral: 0,
      misled: 0,
      silent: 0,
      helpedRate: null,
      byDomain: {},
      emergentDomains: [],
      outcomes: {},
      lastAppliedAt: null
    }
    for (const r of group) {
      if (r.applied === null) {
        u.silent++
        continue
      }
      if (r.applied === false) continue
      u.applied++
      bump(u.outcomes, r.caseOutcome)
      if (!u.lastAppliedAt || r.createdAt > u.lastAppliedAt) u.lastAppliedAt = r.createdAt
      const d = (u.byDomain[r.caseDomain] ??= {
        applied: 0,
        helped: 0,
        neutral: 0,
        misled: 0,
        outcomes: {}
      })
      d.applied++
      bump(d.outcomes, r.caseOutcome)
      const v = effectiveVerdict(r)
      if (v) {
        u[v]++
        d[v]++
      }
    }
    const judged = u.helped + u.neutral + u.misled
    u.helpedRate = u.applied >= MIN_APPLIED && judged > 0 ? u.helped / judged : null
    u.emergentDomains = Object.entries(u.byDomain)
      .filter(([, d]) => d.applied >= MIN_APPLIED && d.helped > d.misled)
      .map(([k]) => k)
      .sort()
    out.push(u)
  }
  return out.sort((a, b) => {
    const ra = a.helpedRate ?? -1
    const rb = b.helpedRate ?? -1
    if (rb !== ra) return rb - ra
    if (a.kind !== b.kind) return ASSET_KINDS.indexOf(a.kind) - ASSET_KINDS.indexOf(b.kind)
    return a.name.localeCompare(b.name)
  })
}

/** OpenTelemetry GenAI `gen_ai.evaluation.result` shape (spec §4.9). Vendor-neutral: every sink
 *  (Langfuse today, OTLP/Datadog later) maps from this and only this. */
export interface AssetAttributionEvent {
  'gen_ai.evaluation.name': 'asset.contribution'
  'gen_ai.evaluation.score.value': 1 | 0 | -1 | null
  'gen_ai.evaluation.score.label': AssetVerdictValue | 'silent'
  'gen_ai.evaluation.explanation': string
  'argus.asset.kind': AssetKind
  'argus.asset.name': string
  'argus.asset.tier': string | null
  'argus.case.domain': string
  'argus.case.outcome': CaseOutcome
  'argus.case.slug': string
  'argus.install.id': string
  'argus.app.version': string
  'argus.judge.model': string
  'argus.judge.prompt_hash': string
  'argus.override.source'?: OverrideSource
}

const SCORE: Record<AssetVerdictValue, 1 | 0 | -1> = { helped: 1, neutral: 0, misled: -1 }

export function toAttributionEvent(
  r: AttributionRow,
  ctx: { installId: string; appVersion: string }
): AssetAttributionEvent {
  const v = effectiveVerdict(r)
  return {
    'gen_ai.evaluation.name': 'asset.contribution',
    'gen_ai.evaluation.score.value': v ? SCORE[v] : null,
    'gen_ai.evaluation.score.label': v ?? 'silent',
    'gen_ai.evaluation.explanation': r.reason,
    'argus.asset.kind': r.assetKind,
    'argus.asset.name': r.assetName,
    'argus.asset.tier': r.assetTier,
    'argus.case.domain': r.caseDomain,
    'argus.case.outcome': r.caseOutcome,
    'argus.case.slug': r.caseSlug,
    'argus.install.id': ctx.installId,
    'argus.app.version': ctx.appVersion,
    'argus.judge.model': r.judgeModel,
    'argus.judge.prompt_hash': r.promptHash,
    ...(r.overrideSource ? { 'argus.override.source': r.overrideSource } : {})
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does free text (a retraction reason) name one of these assets? Whole-token match on the bare
 *  name or a `skill:<name>` / `ref:<relPath>` / `memory:<topic>` token; longest name wins. */
export function matchAssetMention(
  text: string,
  names: { kind: AssetKind; name: string }[]
): { kind: AssetKind; name: string } | null {
  const hay = text.toLowerCase()
  const sorted = [...names].sort((a, b) => b.name.length - a.name.length)
  for (const n of sorted) {
    const re = new RegExp(
      `(^|[^A-Za-z0-9_./-])(?:skill:|ref:|memory:)?${escapeRe(n.name.toLowerCase())}(?![A-Za-z0-9_-])`
    )
    if (re.test(hay)) return n
  }
  return null
}
