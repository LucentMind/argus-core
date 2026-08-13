import type { RcaDraft, CaseRcaInput, Citation } from '../../../shared/rca'
import type { RcaSection, RcaTemplate } from '../../../shared/rcaTemplate'

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

export interface RenderOptions {
  /** The template this draft was generated under — a job's snapshot, never live settings.
   *  Rendering under a template the model never saw would leave new sections blank. */
  template: RcaTemplate
  /** Section ids the user dropped for THIS draft only (increment 3). Distinct from
   *  `enabled: false`, which is a persistent template decision. */
  dropped?: ReadonlySet<string>
}

/** Section id → the pre-template field it rendered from. Keyed by the ids in
 *  `DEFAULT_RCA_TEMPLATE`; a user-added section has no entry and renders empty until
 *  increment 2 teaches the model to fill it. Declared before `narrativeBody` so the
 *  repo's `no-use-before-define` lint rule stays satisfied. */
const LEGACY_NARRATIVE: Record<string, (d: RcaDraft) => string> = {
  'what-happened': (d) => d.execSummary.whatBroke,
  'root-cause': (d) => d.execSummary.why,
  'what-we-did': (d) => d.remediation.immediate,
  'next-steps': (d) => bulletList([d.execSummary.nextSteps, ...d.remediation.followUps]),
  impact: (d) => d.impact
}

/**
 * Body + citations for a narrative section. Increment 2 makes this read
 * `draft.sections[id]` first; today every default narrative section maps to the legacy
 * field it used to render from, so drafts generated before templates still render in full.
 * An unknown id yields an empty body, which `section()` then skips entirely.
 */
function narrativeBody(draft: RcaDraft, id: string): { body: string; citations: Citation[] } {
  const legacy = LEGACY_NARRATIVE[id]
  return { body: legacy ? legacy(draft) : '', citations: [] }
}

/** The exec report's `impact` section reads `execSummary.impact`, the tech report's reads
 *  `draft.impact` — same section id, different source, exactly as the two hardcoded
 *  renderers did before. Resolved by report rather than by id so the ids stay stable. */
const LEGACY_EXEC_IMPACT = (d: RcaDraft): string => d.execSummary.impact

function claimsBody(draft: RcaDraft, slot: NonNullable<RcaSection['slot']>): string {
  switch (slot) {
    case 'root-cause':
      return joinSections([
        `${draft.rootCause.statement}${findingTag(draft.rootCause.findingId)}`,
        citationsBlock(draft.rootCause.evidence)
      ])
    case 'contributing':
      return draft.contributing
        .map((c) =>
          joinSections([`${c.statement}${findingTag(c.findingId)}`, citationsBlock(c.evidence)])
        )
        .join('\n\n')
    case 'symptoms':
      return bulletList(draft.symptoms.map((s) => `${s.statement}${findingTag(s.findingId)}`))
    case 'timeline':
      return bulletList(draft.timeline.map((t) => `${t.at} — ${t.what}`))
    case 'ruled-out':
      return bulletList(
        draft.ruledOut.map((r) => `${r.statement}${findingTag(r.findingId)} — ${r.why}`)
      )
    case 'remediation': {
      const followUps = bulletList(draft.remediation.followUps)
      return joinSections([
        draft.remediation.immediate,
        followUps ? `### Follow-ups\n\n${followUps}` : ''
      ])
    }
    case 'tech-narrative':
      return draft.techNarrative
        .map((n) => section(n.heading, joinSections([n.body, citationsBlock(n.citations)])))
        .filter((s) => s.length > 0)
        .join('\n\n')
  }
}

/** True when the template does not give `timeline` its own section, in which case the
 *  symptoms section carries it as a `### Timeline` sub-block — the pre-template layout. */
function symptomsOwnsTimeline(sections: RcaSection[], dropped: ReadonlySet<string>): boolean {
  return !sections.some(
    (s) => s.enabled && !dropped.has(s.id) && s.kind === 'claims' && s.slot === 'timeline'
  )
}

/** `tech-narrative` emits its own `##` headings, so it is spliced in raw rather than wrapped
 *  in a `## <heading>` block. */
function isSelfHeading(s: RcaSection): boolean {
  return s.kind === 'claims' && s.slot === 'tech-narrative'
}

function renderSections(
  sections: RcaSection[],
  dropped: ReadonlySet<string>,
  bodyFor: (s: RcaSection) => string
): string[] {
  return sections
    .filter((s) => s.enabled && !dropped.has(s.id))
    .map((s) => {
      const body = bodyFor(s)
      return isSelfHeading(s) ? body : section(s.heading, body)
    })
}

/**
 * One-page business report: what happened, impact, root cause in plain terms, what was done,
 * next steps. Sourced only from narrative sections — never from citations, finding ids, or
 * evidence paths. The only reference a reader sees is the Jira issue key.
 */
export function renderExecReport(draft: RcaDraft, meta: CaseMeta, opts: RenderOptions): string {
  const dropped = opts.dropped ?? new Set<string>()
  const bodies = renderSections(opts.template.exec, dropped, (s) =>
    s.id === 'impact' ? LEGACY_EXEC_IMPACT(draft) : narrativeBody(draft, s.id).body
  )
  return joinSections([
    `# RCA — ${meta.title}`,
    meta.jiraKey ? `Jira: ${meta.jiraKey}` : '',
    ...bodies
  ])
}

/**
 * Full technical drill-down. Claims sections render the fixed draft structure; narrative
 * sections render their body plus citations. Empty sections are skipped entirely.
 */
export function renderTechReport(draft: RcaDraft, meta: CaseMeta, opts: RenderOptions): string {
  const dropped = opts.dropped ?? new Set<string>()
  const metaLine = [meta.jiraKey ? `Jira: ${meta.jiraKey}` : '', `Case: ${meta.slug}`]
    .filter((s) => s.length > 0)
    .join(' · ')
  const withTimeline = symptomsOwnsTimeline(opts.template.tech, dropped)
  const bodies = renderSections(opts.template.tech, dropped, (s) => {
    if (s.kind === 'narrative') {
      const { body, citations } = narrativeBody(draft, s.id)
      return joinSections([body, citationsBlock(citations)])
    }
    const body = claimsBody(draft, s.slot!)
    if (s.slot === 'symptoms' && withTimeline) {
      const timeline = claimsBody(draft, 'timeline')
      return joinSections([body, timeline ? `### Timeline\n\n${timeline}` : ''])
    }
    return body
  })
  return joinSections([`# RCA — ${meta.title}`, metaLine, ...bodies])
}
