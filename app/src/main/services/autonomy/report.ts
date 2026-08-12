import fs from 'node:fs'
import path from 'node:path'
import type { AutonomyPayload, LaneStatus } from '../../../shared/autonomy'
import { reportsDir } from '../paths'
import { buildAutonomyPayload, type PayloadDeps } from './payload'

function pct(rate: number | null, accepted: number, decisions: number): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 100)}% (${accepted}/${decisions})`
}

function usd(v: number | null): string {
  return v === null ? 'unattributed' : `$${v.toFixed(2)}`
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'no stamped data'
}

function human(ms: number): string {
  const h = ms / 3600000
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`
}

function historyLine(l: LaneStatus): string[] {
  return l.events.map((e) => {
    const s = e.metricsSnapshot
    const why =
      e.note ??
      `${s.acceptanceRate === null ? '—' : Math.round(s.acceptanceRate * 100) + '%'} of ${s.decisions}`
    return `- ${e.createdAt.slice(0, 10)} ${e.kind} A${e.fromTier}→A${e.toTier} — ${why}`
  })
}

/** Pure markdown from the payload — the report may never reach around the contract to the DB. */
export function renderAutonomyReport(p: AutonomyPayload, now: Date = new Date()): string {
  const lines: string[] = []
  lines.push(`# Autonomy review — ${now.toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push(
    `Argus ${p.argusVersion} · instance \`${p.instanceId}\` · ${p.windowDays}-day window`
  )
  lines.push('', '## Lanes', '')
  lines.push('| Lane | Tier | Decisions | Acceptance | Cost (USD) | Data since |')
  lines.push('|---|---|---|---|---|---|')
  for (const l of p.lanes) {
    const m = l.metrics
    lines.push(
      `| ${l.label} | A${l.tier} | ${m.decisions} | ${pct(m.acceptanceRate, m.accepted, m.decisions)} | ${usd(m.costUsd)} | ${day(m.dataStart)} |`
    )
  }
  lines.push('', '## Reject reasons (distill)', '')
  const rr = p.lanes.find((l) => l.lane === 'distill')?.metrics.rejectReasons ?? {}
  const rrKeys = Object.keys(rr).sort()
  if (rrKeys.length === 0) lines.push('_none in window_')
  else for (const k of rrKeys) lines.push(`- ${k}: ${rr[k]}`)
  lines.push('', '## Depth', '')
  const rf = p.lanes.find((l) => l.lane === 'review-finding')?.metrics.depth ?? {}
  const rc = p.lanes.find((l) => l.lane === 'rca')?.metrics.depth ?? {}
  lines.push(`- Review findings: posted ${rf.posted ?? 0}, applied ${rf.applied ?? 0}`)
  lines.push(
    `- RCA: generated ${rc.generated ?? 0}, confirmed ${rc.confirmed ?? 0}, posted-ok ${rc.postedOk ?? 0}`
  )
  lines.push('', '## Time in triage', '')
  if (p.timeInTriage.medianMs === null) {
    lines.push('_no routed root-cause hypotheses in window_')
  } else {
    lines.push(
      `median ${human(p.timeInTriage.medianMs)}, p90 ${human(p.timeInTriage.p90Ms ?? p.timeInTriage.medianMs)} — over ${p.timeInTriage.cases} cases`
    )
  }
  lines.push('', '## Cost per resolved case', '')
  lines.push(
    p.costPerResolvedCaseUsd === null
      ? '_no resolved cases_'
      : `$${p.costPerResolvedCaseUsd.toFixed(2)} over ${p.resolvedCases} resolved cases`
  )
  lines.push('', '## Tier history', '')
  let anyHistory = false
  for (const l of p.lanes) {
    const h = historyLine(l)
    if (h.length === 0) continue
    anyHistory = true
    lines.push(`### ${l.label}`, '', ...h, '')
  }
  if (!anyHistory) lines.push('_no tier changes recorded_', '')
  lines.push(
    '_Rates computed from stamped decisions only; records predating the outcome stamps count all-time but not in windows._'
  )
  lines.push('')
  return lines.join('\n')
}

export function generateAutonomyReport(deps: PayloadDeps): { file: string; markdown: string } {
  const now = (deps.now ?? (() => new Date()))()
  const payload = buildAutonomyPayload(deps)
  const markdown = renderAutonomyReport(payload, now)
  const dir = reportsDir(deps.argusHome)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `autonomy-review-${now.toISOString().slice(0, 10)}.md`)
  fs.writeFileSync(file, markdown)
  return { file, markdown }
}
