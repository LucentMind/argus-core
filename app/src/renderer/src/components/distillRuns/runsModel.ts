import type {
  DistillProgress,
  DistillRunDetail,
  DistillRunListRow,
  DistillPhase
} from '../../../../shared/distill'
import type {
  DossierCite,
  KnowledgeCandidate,
  PreStageDrop,
  VetoReason
} from '../../../../shared/distillV3'

export interface RunFilters {
  pipeline: ReadonlySet<'v2' | 'v3'>
  mode: ReadonlySet<'dry' | 'real'>
  outcome: ReadonlySet<'failed' | 'zero' | 'running'>
  search: string
}
export const EMPTY_FILTERS: RunFilters = {
  pipeline: new Set(),
  mode: new Set(),
  outcome: new Set(),
  search: ''
}

const inFlight = (r: DistillRunListRow): boolean => r.state === 'queued' || r.state === 'running'

export function applyFilters(rows: DistillRunListRow[], f: RunFilters): DistillRunListRow[] {
  const q = f.search.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.pipeline.size && !(r.pipeline && f.pipeline.has(r.pipeline))) return false
    if (f.mode.size && !f.mode.has(r.dryRun ? 'dry' : 'real')) return false
    if (f.outcome.size) {
      const hit =
        (f.outcome.has('failed') && r.state === 'failed') ||
        (f.outcome.has('zero') && r.state === 'done' && r.itemCount === 0) ||
        (f.outcome.has('running') && inFlight(r))
      if (!hit) return false
    }
    if (q) {
      const hay = `${r.caseSlug} ${r.caseTitle} ${r.jiraKey ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export interface CaseGroup {
  slug: string
  title: string
  jiraKey: string | null
  runs: DistillRunListRow[]
}

/** Input is newest-first (the IPC's order); first sight of a slug is its newest job, so group
 *  order falls out of insertion order. */
export function groupByCase(rows: DistillRunListRow[]): CaseGroup[] {
  const map = new Map<string, CaseGroup>()
  for (const r of rows) {
    const g = map.get(r.caseSlug) ?? {
      slug: r.caseSlug,
      title: r.caseTitle,
      jiraKey: r.jiraKey,
      runs: []
    }
    g.runs.push(r)
    map.set(r.caseSlug, g)
  }
  return [...map.values()]
}

/** `2026-09-04T13:06:00.000Z` → `2026-09-04 13:06`. UTC, not local: the runs list is a shared,
 *  cross-machine audit surface (unlike DistillRunPanel's per-case detail, which stays local time
 *  since the reader is comparing runs they started themselves), so the stamp must read the same
 *  regardless of which machine renders it. */
export function stamp(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const usd = (n: number | null | undefined): string => (n == null ? '$—' : `$${n.toFixed(2)}`)

export function runRowLabel(r: DistillRunListRow): string {
  const parts = [`#${r.id}`]
  if (r.pipeline) parts.push(r.pipeline)
  if (r.dryRun) parts.push('dry')
  parts.push(stamp(r.finishedAt ?? r.createdAt))
  if (r.state === 'failed') return [...parts, 'failed'].join(' · ')
  if (inFlight(r)) return [...parts, r.state].join(' · ')
  if (r.costUsd !== null) parts.push(usd(r.costUsd))
  parts.push(r.itemCount === null ? 'not staged' : `${r.itemCount} staged`)
  return parts.join(' · ')
}

export function phaseLine(p: DistillProgress): string {
  if (p.phase === 'materialize') return p.detail ? `materializing ${p.detail}` : 'materializing'
  if (p.phase === 'summary+candidates') return 'summary ‖ candidates'
  const parts: string[] = [p.phase]
  if (p.toolCalls !== undefined)
    parts.push(`${p.toolCalls} tool call${p.toolCalls === 1 ? '' : 's'}`)
  if (p.detail) parts.push(p.detail)
  return parts.join(' · ')
}

export type StripState = 'done' | 'error' | 'not-reached' | 'running' | 'pending' | 'skipped'
export interface StripNode {
  id: string
  label: string
  stat: string
  state: StripState
  error?: string
}

const VETO_REASONS: ReadonlySet<string> = new Set<VetoReason>([
  'malformed',
  'unknown-target',
  'target-exists',
  'confluence-tier',
  'bad-name',
  'duplicate',
  'kind-type-mismatch',
  'cap'
])
const V3_ORDER: { id: string; label: string; phase: DistillPhase | null }[] = [
  { id: 'input', label: 'input', phase: null },
  { id: 'dossier', label: 'dossier', phase: 'dossier' },
  { id: 'summary', label: 'summary', phase: 'summary+candidates' },
  { id: 'candidates', label: 'candidates', phase: 'summary+candidates' },
  { id: 'veto', label: 'veto', phase: 'veto' },
  { id: 'materialize', label: 'materialize', phase: 'materialize' },
  { id: 'validators', label: 'validators', phase: 'validators' },
  { id: 'staged', label: 'staged', phase: 'staging' }
]
const PHASE_INDEX: Record<DistillPhase, number> = {
  agent: 0,
  dossier: 0,
  'summary+candidates': 1,
  veto: 2,
  materialize: 3,
  validators: 4,
  staging: 5
}
const NODE_PHASE_INDEX: Record<string, number> = {
  input: -1,
  dossier: 0,
  summary: 1,
  candidates: 1,
  veto: 2,
  materialize: 3,
  validators: 4,
  staged: 5,
  agent: 0
}

function reasonsLine(drops: PreStageDrop[]): string {
  const seen: string[] = []
  for (const d of drops) if (!seen.includes(d.reason)) seen.push(d.reason)
  return `−${drops.length}${seen.length ? ` · ${seen.join(', ')}` : ''}`
}

export function stripNodes(
  detail: DistillRunDetail,
  progress: DistillProgress | null
): StripNode[] {
  const job = detail.job
  const live = job.state === 'queued' || job.state === 'running'
  const stagedNode = (): StripNode => {
    if (job.dryRun)
      return { id: 'staged', label: 'staged', stat: 'not staged (dry run)', state: 'skipped' }
    if (job.state === 'done')
      return { id: 'staged', label: 'staged', stat: `${job.itemCount ?? 0} staged`, state: 'done' }
    return { id: 'staged', label: 'staged', stat: '—', state: 'not-reached' }
  }
  const liveState = (nodeId: string): StripState => {
    const cur = progress ? PHASE_INDEX[progress.phase] : -1
    const mine = NODE_PHASE_INDEX[nodeId]
    if (mine < 0) return 'done'
    if (mine < cur) return 'done'
    if (mine === cur) return 'running'
    return 'pending'
  }
  const input: StripNode = {
    id: 'input',
    label: 'input',
    stat: `${detail.inputSnapshotChars} chars`,
    state: 'done'
  }

  if (detail.pipeline !== 'v3' && !detail.stages) {
    const agent: StripNode = live
      ? {
          id: 'agent',
          label: 'agent',
          stat: progress ? phaseLine(progress) : '…',
          state: liveState('agent')
        }
      : {
          id: 'agent',
          label: 'agent',
          stat: `${job.turnCount ?? 0} turns · ${job.toolCallCount ?? 0} tool calls · ${usd(job.costUsd)}`,
          state: job.state === 'failed' ? 'error' : 'done',
          ...(job.error ? { error: job.error } : {})
        }
    return [
      input,
      agent,
      live ? { id: 'staged', label: 'staged', stat: '—', state: liveState('staged') } : stagedNode()
    ]
  }

  if (live) {
    return V3_ORDER.map((n) =>
      n.id === 'input'
        ? input
        : {
            id: n.id,
            label: n.label,
            stat: n.id === 'staged' && job.dryRun ? 'skipped (dry run)' : '…',
            state: liveState(n.id)
          }
    )
  }

  const s = detail.stages ?? {}
  const rec = (
    r: { error?: string; usage?: { costUsd?: number } } | undefined,
    stat: string
  ): Pick<StripNode, 'stat' | 'state' | 'error'> =>
    r
      ? r.error
        ? { stat, state: 'error', error: r.error }
        : { stat, state: 'done' }
      : { stat: '—', state: 'not-reached' }
  const veto = detail.dropped.filter((d) => VETO_REASONS.has(d.reason))
  const validators = detail.dropped.filter(
    (d) => !VETO_REASONS.has(d.reason) && d.reason !== 'cap' && d.reason !== 'basis'
  )
  const mats = Array.isArray(s.materialize) ? s.materialize : []
  const matCost = mats.reduce((a, m) => a + (m.usage?.costUsd ?? 0), 0)
  const matErr = mats.find((m) => m.error)
  return [
    input,
    {
      id: 'dossier',
      label: 'dossier',
      ...rec(s.dossier, `${usd(s.dossier?.usage?.costUsd)} · ${job.toolCallCount ?? 0} tool calls`)
    },
    {
      id: 'summary',
      label: 'summary',
      ...rec(
        s.summary,
        detail.parsed.summary ? 'summary' : detail.parsed.summaryPresent ? 'null' : '—'
      )
    },
    {
      id: 'candidates',
      label: 'candidates',
      ...rec(
        s.candidates,
        `${usd(s.candidates?.usage?.costUsd)} · ${detail.parsed.candidates?.length ?? 0} out`
      )
    },
    {
      id: 'veto',
      label: 'veto',
      stat: reasonsLine(veto),
      state: s.candidates && !s.candidates.error ? 'done' : 'not-reached'
    },
    {
      id: 'materialize',
      label: 'materialize',
      stat: mats.length
        ? `×${mats.length} · ${usd(matCost)}`
        : s.candidates && !s.candidates.error
          ? '×0'
          : '—',
      state: mats.length
        ? matErr
          ? 'error'
          : 'done'
        : s.candidates && !s.candidates.error
          ? 'done'
          : 'not-reached',
      ...(matErr?.error ? { error: matErr.error } : {})
    },
    {
      id: 'validators',
      label: 'validators',
      stat: reasonsLine(validators),
      state: mats.length ? 'done' : 'not-reached'
    },
    stagedNode()
  ]
}

export type CandidateVerdict = { kind: 'kept' } | { kind: 'dropped'; reason: string }

export function classifyCandidates(
  candidates: KnowledgeCandidate[],
  dropped: PreStageDrop[]
): { candidate: KnowledgeCandidate; verdict: CandidateVerdict }[] {
  return candidates.map((candidate) => {
    const d = dropped.find((x) => x.type === candidate.type && x.target === candidate.target)
    return { candidate, verdict: d ? { kind: 'dropped', reason: d.reason } : { kind: 'kept' } }
  })
}

export function citeLabel(c: DossierCite): string {
  if ('finding' in c) return `finding ${c.finding}`
  if ('session' in c) return `s${c.session}:t${c.turn}`
  return `ev ${c.evidence}`
}

export function dropBreakdown(dropped: PreStageDrop[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const x of dropped) counts.set(x.reason, (counts.get(x.reason) ?? 0) + 1)
  return [...counts.entries()]
}
