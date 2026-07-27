/**
 * The review layers a code review runs as separate passes (spec §5).
 *
 * Data-driven on purpose: a follow-up pack spec is meant to register additional layers or
 * override built-ins, so nothing here may be hardcoded at a call site. Three consumers read
 * this table — the prompt catalog (services/prompts/registry.ts), the subagent compiler
 * (services/agent/reviewSubagents.ts), and the run composer (services/agent/reviewRun.ts).
 *
 * Pure: no node:*, no Electron, no main/ imports (the shared/ constraint).
 */

export type ReviewLayerId = 'correctness' | 'security' | 'tests' | 'design-conformance'

export interface ReviewLayerDefinition {
  id: ReviewLayerId
  /** Human label — layer chips, findings badges, the pin menu. */
  label: string
  /** Model-facing: when the main agent should pick this layer without being asked. */
  appliesWhen: string
  /** The layer subagent's identity, composed ahead of its task prompt. */
  personaFragment: string
  /** The task handed to the layer run. */
  prompt: string
}

export const SEVERITIES = ['critical', 'major', 'minor'] as const
export type ReviewSeverity = (typeof SEVERITIES)[number]

/** Exported so the review-run composer (main/services/agent/reviewRun.ts) can strip it back
 *  out when a layer's task text is inlined into a turn for an agent that is NOT a delegate —
 *  it does have a findings tool and is told to use it (finding 1 of the layered-review review;
 *  see reviewRun.ts's stripCandidateContract). */
export const CANDIDATE_CONTRACT = `
Return candidates only — do NOT record findings. You have no findings tool. For each candidate
emit exactly:
  CANDIDATE
  citation: [<repo-name>/<repo-relative-path>:<line>]
  severity: critical | major | minor
  scenario: the concrete input or state under which the change misbehaves
  why: one paragraph, citing the code you read
Emit nothing else. If you found nothing, reply with the single line NO CANDIDATES.
`.trim()

export const REVIEW_LAYERS: Record<ReviewLayerId, ReviewLayerDefinition> = {
  correctness: {
    id: 'correctness',
    label: 'Correctness',
    appliesWhen: 'Always — any diff that changes behavior.',
    personaFragment: `
You review one dimension of a pull request: CORRECTNESS. Logic errors, wrong edge-case
handling, regressions in behavior the change did not intend to touch, incorrect assumptions
about data or state, missing error handling that ends in a crash.
`.trim(),
    prompt: `
Read the diff, then chase every suspicion: search the repo for callers of the changed code,
read the git history of the touched lines, and run what you can in the worktree. Only issues
introduced or worsened by the CHANGED lines count — a pre-existing bug the diff merely moved
is not a candidate. Before emitting a candidate, try to refute it against the actual code.

${CANDIDATE_CONTRACT}
`.trim()
  },
  security: {
    id: 'security',
    label: 'Security',
    appliesWhen:
      'The diff touches input parsing, authz/authn, secrets, deserialization, file or network I/O, or subprocess invocation.',
    personaFragment: `
You review one dimension of a pull request: SECURITY. Injection, authorization and
authentication gaps, secret handling, unsafe deserialization, path traversal, unsafe
subprocess construction, and data that crosses a trust boundary without validation.
`.trim(),
    prompt: `
Read the diff and trace where untrusted input reaches the changed code. Follow each tainted
value to the sink and read the sink's implementation before judging it. A theoretical risk that
needs an unlikely precondition is not a candidate; say so and move on.

${CANDIDATE_CONTRACT}
`.trim()
  },
  tests: {
    id: 'tests',
    label: 'Tests',
    appliesWhen:
      'Always, unless the diff is docs-only. Especially when it changes behavior but touches no test file.',
    personaFragment: `
You review one dimension of a pull request: TEST COVERAGE. Whether the change's new behavior
is actually exercised, whether the assertions would fail if the implementation were wrong, and
which realistic input the tests leave uncovered.
`.trim(),
    prompt: `
Read the diff and the test files it touches. For each behavioral change, find the test that
would fail if that change were reverted. If there is none, that is a candidate. A test that
asserts only that the code ran (no meaningful assertion) is also a candidate. Do not ask for
tests of trivial or generated code.

${CANDIDATE_CONTRACT}
`.trim()
  },
  'design-conformance': {
    id: 'design-conformance',
    label: 'Design conformance',
    appliesWhen:
      'The case carries a ticket, spec or acceptance criteria in its evidence, or the PR description states intended behavior.',
    personaFragment: `
You review one dimension of a pull request: CONFORMANCE. Whether the change does what the
ticket, spec or acceptance criteria say it should — including the parts it silently skipped.
`.trim(),
    prompt: `
Read the stated intent (ticket, spec, acceptance criteria, PR description) and then the diff.
Report where the implementation diverges from the stated intent, and any acceptance criterion
with no corresponding change. If the case carries no stated intent, reply with the single line
NO CANDIDATES rather than inventing criteria.

${CANDIDATE_CONTRACT}
`.trim()
  }
}

// Derived from REVIEW_LAYERS' own key order, the same reasoning as MODE_ORDER in
// shared/modes.ts: an object literal's key order IS insertion order, so a fifth layer needs
// one edit and a hand-maintained parallel list cannot fall out of sync.
export const REVIEW_LAYER_ORDER: ReviewLayerId[] = Object.keys(REVIEW_LAYERS) as ReviewLayerId[]

export function isReviewLayerId(v: unknown): v is ReviewLayerId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(REVIEW_LAYERS, v)
}

export function isReviewSeverity(v: unknown): v is ReviewSeverity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
}
