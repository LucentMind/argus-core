import type { RcaDraft, CaseRcaInput, Citation } from '../../../shared/rca'

/**
 * Deterministic markdown renderers for a confirmed RCA draft. Pure template functions: no I/O,
 * no lookups — everything comes from `draft` and `meta`. A later task writes their output to
 * artifact files verbatim, so formatting here IS the shipped report.
 */

type CaseMeta = CaseRcaInput['caseMeta']

function citationRef(c: Citation): string {
  return c.line != null ? `\`${c.path}:${c.line}\`` : `\`${c.path}\``
}

/** A single citation flattened to inline code, plus an optional `> evidence` blockquote line. */
function citationBlock(c: Citation): string {
  const ref = citationRef(c)
  return c.evidence ? `${ref}\n> ${c.evidence}` : ref
}

function citationsBlock(cites: Citation[]): string {
  return cites.map(citationBlock).join('\n\n')
}

function findingTag(findingId: number | null): string {
  return findingId != null ? ` (finding ${findingId})` : ''
}

/** Joins non-empty parts with a blank line; empty/whitespace-only parts are dropped silently
 *  so a section with no content never leaves "(none)" noise in the shipped report. */
function joinSections(parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n\n')
}

function bulletList(items: string[]): string {
  return items
    .map((i) => i.trim())
    .filter((i) => i.length > 0)
    .map((i) => `- ${i}`)
    .join('\n')
}

/** `## <heading>` followed by `body`, or '' entirely when `body` is empty — sections are skipped,
 *  never rendered as a placeholder. */
function section(heading: string, body: string): string {
  const trimmed = body.trim()
  return trimmed ? `## ${heading}\n\n${trimmed}` : ''
}

/**
 * One-page business report: what happened, impact, root cause in plain terms, what was done,
 * next steps. Sourced only from `execSummary` and `remediation` — never from citations, finding
 * ids, or evidence paths. The only reference a reader sees is the Jira issue key.
 */
export function renderExecReport(draft: RcaDraft, meta: CaseMeta): string {
  const { execSummary, remediation } = draft

  const nextSteps = bulletList([execSummary.nextSteps, ...remediation.followUps])

  return joinSections([
    `# RCA — ${meta.title}`,
    meta.jiraKey ? `Jira: ${meta.jiraKey}` : '',
    section('What happened', execSummary.whatBroke),
    section('Impact', execSummary.impact),
    section('Root cause', execSummary.why),
    section('What we did', remediation.immediate),
    section('Next steps', nextSteps)
  ])
}

/**
 * Full technical drill-down: root cause with citations, contributing factors, symptoms &
 * timeline, ruled-out hypotheses (each with its why), remediation + follow-ups, then the
 * free-form technical narrative. Empty sections are skipped entirely.
 */
export function renderTechReport(draft: RcaDraft, meta: CaseMeta): string {
  const metaLine = [meta.jiraKey ? `Jira: ${meta.jiraKey}` : '', `Case: ${meta.slug}`]
    .filter((s) => s.length > 0)
    .join(' · ')

  const rootCauseBody = joinSections([
    `${draft.rootCause.statement}${findingTag(draft.rootCause.findingId)}`,
    citationsBlock(draft.rootCause.evidence)
  ])

  const contributingBody = draft.contributing
    .map((c) =>
      joinSections([`${c.statement}${findingTag(c.findingId)}`, citationsBlock(c.evidence)])
    )
    .join('\n\n')

  const symptomsList = bulletList(
    draft.symptoms.map((s) => `${s.statement}${findingTag(s.findingId)}`)
  )
  const timelineList = bulletList(draft.timeline.map((t) => `${t.at} — ${t.what}`))
  const symptomsBody = joinSections([
    symptomsList,
    timelineList ? `### Timeline\n\n${timelineList}` : ''
  ])

  const ruledOutList = bulletList(
    draft.ruledOut.map((r) => `${r.statement}${findingTag(r.findingId)} — ${r.why}`)
  )

  const followUps = bulletList(draft.remediation.followUps)
  const remediationBody = joinSections([
    draft.remediation.immediate,
    followUps ? `### Follow-ups\n\n${followUps}` : ''
  ])

  const narrative = draft.techNarrative
    .map((n) => section(n.heading, joinSections([n.body, citationsBlock(n.citations)])))
    .filter((s) => s.length > 0)
    .join('\n\n')

  return joinSections([
    `# RCA — ${meta.title}`,
    metaLine,
    section('Root cause', rootCauseBody),
    section('Contributing factors', contributingBody),
    section('Symptoms & timeline', symptomsBody),
    section('Ruled out', ruledOutList),
    section('Remediation', remediationBody),
    narrative
  ])
}
