import type { CaseRcaInput } from '../../../shared/rca'
import type { PromptTextSpecs } from '../../../shared/promptSpec'
import type { RcaSection, RcaTemplate } from '../../../shared/rcaTemplate'

/**
 * The system contract handed to the headless case-RCA drafter. Mirrors
 * `distill/contract.ts`'s shape: a fixed contract plus a `PromptTextSpecs` record of section
 * headers, assembled by `buildCaseRcaPrompt` with the dynamic case payload staying in code.
 */
export const RCA_CONTRACT = `
You are drafting a root-cause-analysis structure for a defect investigation case. You have
no tools: everything you may cite is inline below. Return exactly one fenced \`\`\`json
block matching this TypeScript shape, and nothing else:

interface RcaDraft {
  rootCause: { findingId: number | null; statement: string; evidence: { path: string; line?: number; evidence?: string }[] }
  contributing: { findingId: number | null; statement: string; evidence: {...same}[] }[]
  symptoms: { findingId: number | null; statement: string }[]
  ruledOut: { findingId: number | null; statement: string; why: string }[]
  duplicates: { findingId: number; ofFindingId: number }[]
  impact: string
  timeline: { at: string; what: string }[]
  remediation: { immediate: string; followUps: string[] }
  execSummary: { whatBroke: string; impact: string; why: string; nextSteps: string }
  techNarrative: { heading: string; body: string; citations: {...same}[] }[]
  sections: Record<string, { body: string; citations: {...same}[] }>
}

Rules:
1. Every rootCause/contributing/symptom/ruledOut entry that restates a finding below MUST
   carry that finding's id in findingId; use null only for claims no finding covers.
2. Exactly one rootCause. If the evidence does not support a confident root cause, say so
   in the statement and set findingId null — do not invent certainty.
3. ruledOut entries must say WHY each hypothesis was ruled out.
4. duplicates: list finding pairs that state the same fact; ofFindingId is the one kept.
5. sections: return one entry for EVERY id listed under "Report sections" below — no more are
   required, none may be omitted. Write each section's body to its own instruction. Cite
   evidence with \`citations\` only where the instruction allows it.
6. Citations point at evidence files (relPath from the evidence inventory) or repo paths
   exactly as they appear in findings — never invent paths.
7. Respect prior human edits: if a "previously confirmed structure" section is present,
   keep its role decisions unless the findings contradict them.
`.trim()

export const RCA_SECTIONS: PromptTextSpecs = {
  sections: {
    title: 'RCA section — report sections to write',
    text: '# Report sections (write one `sections` entry per id)'
  },
  case: { title: 'RCA section — case metadata', text: '# Case' },
  ticket: { title: 'RCA section — Jira ticket', text: '# Jira ticket (as ingested)' },
  comments: { title: 'RCA section — Jira comments', text: '# Jira comments (as ingested)' },
  findings: {
    title: 'RCA section — findings',
    text: '# Findings (id, review state, current role)'
  },
  evidence: {
    title: 'RCA section — evidence inventory',
    text: '# Evidence inventory (citable relPaths)'
  },
  transcripts: {
    title: 'RCA section — chat transcripts',
    text: '# Investigation chat (tail per session)'
  },
  prior: {
    title: 'RCA section — previously confirmed structure',
    text: '# Previously confirmed structure (keep its decisions unless contradicted)'
  },
  'output-nudge': {
    title: 'RCA — closing output instruction',
    text: 'Return exactly one fenced ```json block now.'
  }
}

/** One brief per enabled narrative section, grouped by the report it belongs to. Claims
 *  sections are omitted: they render fixed draft structure the model already produces under
 *  its own keys, so briefing them would invite duplicate content. */
function sectionBriefs(template: RcaTemplate): string {
  const group = (label: string, sections: RcaSection[]): string => {
    const rows = sections
      .filter((s) => s.enabled && s.kind === 'narrative')
      .map((s) => `- "${s.id}" — heading "${s.heading}"\n  ${s.instruction ?? ''}`)
      .join('\n')
    return rows ? `## ${label}\n${rows}` : ''
  }
  return [
    group('Executive summary (a non-technical reader)', template.exec),
    group('Technical report', template.tech)
  ]
    .filter((s) => s.length > 0)
    .join('\n\n')
}

export function buildCaseRcaPrompt(
  input: CaseRcaInput,
  template: RcaTemplate,
  resolve?: (id: string) => string
): string {
  const sec = (k: string): string =>
    resolve ? resolve(`headless.case-rca.section.${k}`) : RCA_SECTIONS[k].text
  const m = input.caseMeta
  const findings = input.findings
    .map(
      (f) =>
        `### [finding ${f.id}] [${f.reviewState}${f.role ? ` · ${f.role}` : ''}] ${f.summary}\n${f.body}`
    )
    .join('\n\n')
  const parts = [
    resolve ? resolve('headless.case-rca.contract') : RCA_CONTRACT,
    `${sec('sections')}\n${sectionBriefs(template)}`,
    `${sec('case')}\nslug: ${m.slug}\ntitle: ${m.title}\njira: ${m.jiraKey ?? '—'}\nresolution: ${m.resolution ?? '—'}\ntags: ${m.tags.join(', ') || '—'}\nopened: ${m.createdAt}`,
    `${sec('ticket')}\n${input.jiraTicketMarkdown ?? '(none)'}`,
    `${sec('comments')}\n${input.jiraCommentsMarkdown ?? '(none)'}`,
    `${sec('findings')}\n\n${findings || '(none)'}`,
    `${sec('evidence')}\n${input.evidence.map((e) => `- ${e.relPath} (${e.artifactType}, ${e.size} bytes)`).join('\n') || '(none)'}`,
    `${sec('transcripts')}\n${input.transcripts.map((t) => `## ${t.title}\n${t.text}`).join('\n\n') || '(none)'}`
  ]
  if (input.priorDraft) parts.push(`${sec('prior')}\n${JSON.stringify(input.priorDraft, null, 2)}`)
  parts.push(sec('output-nudge'))
  return parts.join('\n\n')
}
