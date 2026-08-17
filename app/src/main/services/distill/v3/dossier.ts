import type { CaseDistillInput } from '../../../../shared/distill'
import type { Dossier, DossierCite, DossierCited } from '../../../../shared/distillV3'
import type { PromptTextSpecs } from '../../../../shared/promptSpec'
import { DistillParseError } from '../contract'

/**
 * Stage 1 of the v3 pipeline. Answers only: what is established about this case, on what
 * evidence, and how was it established. It never decides what is durable, never routes a
 * type, and never writes prose for humans — those are stages 2a/2b/3. It is the ONLY stage
 * that reads transcripts (tools over the frozen world).
 */
export const DOSSIER_CONTRACT = `You are building an evidence dossier for one root-cause-analysis case. Later, separate passes will decide what (if anything) in this dossier is durable knowledge — your job is to record what is ESTABLISHED, on what EVIDENCE, and HOW it was established. You do not generalize, you do not decide what is reusable, and you do not write for humans.

EVIDENCE HIERARCHY — strongest first. Every item you record carries "cites" naming where it comes from:
  1. A finding marked [accepted] with a citation — human-reviewed; admissible for anything.
  2. Tool output or an evidence artifact the assistant READ in the transcript (a log grep, a command result, a query) — primary evidence. Cite it as {"session": id, "turn": n} or {"evidence": "relPath"}.
  3. The user's own statement in a user turn.
  4. The assistant's own claim. A claim is a HYPOTHESIS unless a finding or an artifact confirms it. Decisive values very often live only in tool outputs the assistant read — those outputs are evidence; the assistant's sentence ABOUT them is not.
A finding marked [rejected] or with role ruled-out is INADMISSIBLE as a cause or fix — record it under rejected_hypotheses with HOW it was ruled out. A [pending] finding is inadmissible for root_cause / confirmed_fix but may appear in diagnostic_path.

RULES:
1. ROOT CAUSE: the finding with role root-cause (assigned by a human-confirmed RCA) anchors "root_cause". If that finding is still [pending], record it and say so in scope.note. No root-cause role and no accepted causal finding → root_cause is null.
2. OPEN CASE: status open ⇒ scope.settled=false, confirmed_fix MUST be null, root_cause only from [accepted] findings.
3. RESOLUTION: wont-fix ⇒ confirmed_fix.applied=false with the reason in text; forwarded / duplicate / rejected / not-reproducible ⇒ usually only scope + rejected_hypotheses; that is a valid dossier.
4. DIAGNOSTIC PATH: in investigation order, not importance. For each step record what was checked, what was observed, and which hypothesis it separated from which. This is what a future procedure will be built from — do not compress it into conclusions.
5. DURABLE FACTS: candidate facts a future agent might consult — thresholds, log signatures, schemas, component behaviour, version splits, product limitations. Keep a verbatim quote (≤ 300 chars) and the SCOPE (component / version / mode / flag / condition) — never generalize here; dropping scope may turn a true statement false. Session-local "X did not work" about the agent's own tools/environment is NOT a durable fact.
6. USER CORRECTIONS: places the user corrected or steered the assistant — verbatim gist, cited.
7. CITES: every array item and every non-null scalar has ≥ 1 cite of exactly one of {"finding": id}, {"session": id, "turn": n}, {"evidence": "relPath"}. An item you cannot cite does not go in the dossier.
8. TOOLS: list_sessions / read_transcript / search_transcript read this case's conversation (snapshot at enqueue); run_tool_script sweeps across sessions. Do not re-read what the input already contains; read slices when a finding or user message references work you must see. Work in as many turns as you need.
9. OUTPUT: your FINAL assistant message contains exactly one fenced \`\`\`json block with one object having exactly these keys: scope {status, resolution, settled, note}, root_cause, confirmed_fix {text, applied, cites}, rejected_hypotheses[], diagnostic_path[], durable_facts[], user_corrections[]. No other keys, no commentary inside the block. Intermediate turns are working turns and are not parsed.`

export const DOSSIER_SECTIONS: PromptTextSpecs = {
  case: { title: 'Dossier section — case metadata', text: '# Case' },
  findings: { title: 'Dossier section — findings', text: '# Findings (id · review state · role)' },
  evidence: { title: 'Dossier section — evidence', text: '# Evidence inventory' },
  sessions: { title: 'Dossier section — chat sessions', text: '# Chat sessions' },
  'user-messages': {
    title: 'Dossier section — user messages',
    text: '# User messages (newest sessions first; corrections and steering live here)'
  },
  rca: {
    title: 'Dossier section — confirmed RCA structure',
    text: '# Confirmed RCA structure (human-reviewed)'
  },
  'output-nudge': {
    title: 'Dossier — closing output instruction',
    text: 'Return exactly one fenced ```json block now.'
  }
}

export function buildDossierPrompt(
  input: CaseDistillInput,
  resolve?: (id: string) => string
): string {
  const m = input.caseMeta
  const sec = (key: string): string =>
    resolve ? resolve(`headless.case-distill.dossier.section.${key}`) : DOSSIER_SECTIONS[key].text
  const findings = input.findings
    .map(
      (f) =>
        `### [${f.id !== undefined ? `#${f.id} · ` : ''}${f.reviewState}${f.role ? ` · ${f.role}` : ''}] ${f.summary}\n${f.body}`
    )
    .join('\n\n')
  const parts = [
    resolve ? resolve('headless.case-distill.dossier.contract') : DOSSIER_CONTRACT,
    `${sec('case')}\nslug: ${m.slug}\ntitle: ${m.title}\njira: ${m.jiraKey ?? '—'}\nstatus: ${m.status ?? 'closed'}\nresolution: ${m.resolution ?? '—'}\ntags: ${m.tags.join(', ') || '—'}\nopened: ${m.createdAt}${m.status !== 'open' ? `\nclosed: ${m.closedAt}` : ''}`,
    `${sec('findings')}\n\n${findings || '(none)'}`,
    `${sec('evidence')}\n${input.evidence.map((e) => `- ${e.relPath} (${e.artifactType}, ${e.size} bytes)`).join('\n') || '(none)'}`,
    `${sec('sessions')}\n${input.sessionTitles.map((t) => `- ${t}`).join('\n') || '(none)'}`
  ]
  if (input.userMessages && input.userMessages.length > 0) {
    parts.push(
      `${sec('user-messages')}\n${input.userMessages
        .map((s) => `## ${s.sessionTitle}\n${s.messages.map((x) => `- ${x}`).join('\n')}`)
        .join('\n\n')}`
    )
  }
  if (input.rcaStructure)
    parts.push(`${sec('rca')}\n${JSON.stringify(input.rcaStructure, null, 2)}`)
  parts.push(sec('output-nudge'))
  return parts.join('\n\n')
}

const DOSSIER_KEYS = [
  'scope',
  'root_cause',
  'confirmed_fix',
  'rejected_hypotheses',
  'diagnostic_path',
  'durable_facts',
  'user_corrections'
]
const ARRAY_KEYS = [
  'rejected_hypotheses',
  'diagnostic_path',
  'durable_facts',
  'user_corrections'
] as const
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function extractFence(text: string): string {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
  if (fences.length !== 1)
    throw new DistillParseError(`expected exactly 1 json fence, got ${fences.length}`, text)
  return fences[0][1]
}

function isCite(v: unknown): v is DossierCite {
  if (!isObj(v)) return false
  const keys = Object.keys(v)
  if (keys.length === 1 && keys[0] === 'finding') return typeof v.finding === 'number'
  if (keys.length === 1 && keys[0] === 'evidence') return isStr(v.evidence) && v.evidence.length > 0
  if (keys.length === 2 && 'session' in v && 'turn' in v)
    return typeof v.session === 'number' && typeof v.turn === 'number'
  return false
}

/** Validates `cites` on one item: returns null when the item is uncited (drop it), throws on a
 *  malformed cite (a model that invents cite shapes must fail loudly, not silently lose data). */
function checkCites(item: unknown, text: string): DossierCite[] | null {
  if (!isObj(item) || !Array.isArray(item.cites)) return null
  for (const c of item.cites)
    if (!isCite(c)) throw new DistillParseError(`malformed cite ${JSON.stringify(c)}`, text)
  return item.cites.length > 0 ? (item.cites as DossierCite[]) : null
}

export function parseDossier(text: string): {
  dossier: Dossier
  uncitedDropped: Record<string, number>
} {
  let obj: unknown
  try {
    obj = JSON.parse(extractFence(text))
  } catch (e) {
    throw new DistillParseError(`invalid JSON: ${(e as Error).message}`, text)
  }
  if (!isObj(obj)) throw new DistillParseError('dossier is not an object', text)
  for (const k of Object.keys(obj))
    if (!DOSSIER_KEYS.includes(k)) throw new DistillParseError(`unknown key "${k}"`, text)
  const s = obj.scope
  if (
    !isObj(s) ||
    (s.status !== 'open' && s.status !== 'closed') ||
    typeof s.settled !== 'boolean' ||
    !isStr(s.note)
  )
    throw new DistillParseError('scope invalid', text)
  const uncitedDropped: Record<string, number> = {}
  const dossier: Dossier = {
    scope: {
      status: s.status,
      resolution: isStr(s.resolution) ? s.resolution : null,
      settled: s.settled,
      note: s.note
    },
    root_cause: null,
    confirmed_fix: null,
    rejected_hypotheses: [],
    diagnostic_path: [],
    durable_facts: [],
    user_corrections: []
  }
  if (isObj(obj.root_cause) && isStr(obj.root_cause.text)) {
    const cites = checkCites(obj.root_cause, text)
    if (cites) dossier.root_cause = { text: obj.root_cause.text, cites }
    else uncitedDropped.root_cause = 1
  }
  if (isObj(obj.confirmed_fix) && isStr(obj.confirmed_fix.text)) {
    const cites = checkCites(obj.confirmed_fix, text)
    if (cites)
      dossier.confirmed_fix = {
        text: obj.confirmed_fix.text,
        applied: obj.confirmed_fix.applied !== false,
        cites
      }
    else uncitedDropped.confirmed_fix = 1
  }
  for (const key of ARRAY_KEYS) {
    const arr = obj[key]
    if (arr === undefined) continue
    if (!Array.isArray(arr)) throw new DistillParseError(`${key} must be an array`, text)
    for (const item of arr) {
      if (!isObj(item)) throw new DistillParseError(`${key} item is not an object`, text)
      const cites = checkCites(item, text)
      if (!cites) {
        uncitedDropped[key] = (uncitedDropped[key] ?? 0) + 1
        continue
      }
      const str = (k: string): string => (isStr(item[k]) ? (item[k] as string) : '')
      switch (key) {
        case 'rejected_hypotheses':
          dossier.rejected_hypotheses.push({
            text: str('text'),
            how_ruled_out: str('how_ruled_out'),
            cites
          })
          break
        case 'diagnostic_path':
          dossier.diagnostic_path.push({
            step: str('step'),
            observation: str('observation'),
            discriminated: str('discriminated'),
            cites
          })
          break
        case 'durable_facts':
          dossier.durable_facts.push({
            fact: str('fact'),
            quote: str('quote').slice(0, 300),
            scope: isStr(item.scope) ? item.scope : null,
            cites
          })
          break
        case 'user_corrections':
          dossier.user_corrections.push({ text: str('text'), cites })
          break
      }
    }
  }
  return { dossier, uncitedDropped }
}

/** `root_cause` | `confirmed_fix` | `<array>[<i>]` → the cited item, or null. */
export function resolveDossierPath(d: Dossier, path: string): DossierCited | null {
  if (path === 'root_cause') return d.root_cause
  if (path === 'confirmed_fix') return d.confirmed_fix
  const m = path.match(
    /^(rejected_hypotheses|diagnostic_path|durable_facts|user_corrections)\[(\d+)\]$/
  )
  if (!m) return null
  const arr = d[m[1] as (typeof ARRAY_KEYS)[number]] as DossierCited[]
  return arr[Number(m[2])] ?? null
}
