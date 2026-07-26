/**
 * Model-facing text that is deliberately NOT yet a registry entry.
 *
 * The coverage test (`__tests__/coverage.test.ts`) requires every long literal in a
 * prompt-bearing file to be either resolvable through the registry or listed here. Adding a
 * prompt without doing one or the other fails the build — that is the point. This list should
 * shrink to empty as the later plans land; it is not a permanent parking space.
 */
export interface DeferredPrompt {
  /** Repo-relative file the literal lives in. */
  file: string
  /** Human label for the literal (symbol name, or a short description). */
  symbol: string
  reason: string
  /** Which plan registers it. */
  plannedIn: string
  /**
   * How many unregistered model-facing literals this file is currently expected to contain.
   *
   * Load-bearing. Without it, listing a file here exempts EVERY literal in it, so adding a
   * brand-new prompt to a deferred file would slip past the guard silently. With the count, a
   * new prompt changes the tally and fails the test, forcing whoever added it to either
   * register it or bump this number deliberately and say why.
   */
  count: number
}

export const DEFERRED_PROMPTS: readonly DeferredPrompt[] = [
  {
    file: 'app/src/main/services/agent/nativeTools.ts',
    symbol: 'model-facing tool return / steering strings (~12)',
    reason:
      'Returned as tool output rather than declared as prompt text; needs per-string ids and a handler-level seam.',
    plannedIn: 'Plan 3',
    // Empirically 0: every literal the scanner finds in this file (the 4 tool `description`
    // strings that clear MIN_CHARS + PROMPTY) is already registered via TOOL_ENTRIES in
    // registry.ts, which maps NATIVE_TOOL_SPECS 1:1. The ~12 tool-return/steering strings this
    // entry's symbol/reason describe are real but currently fall under MIN_CHARS or don't match
    // PROMPTY, so the scanner doesn't see them as unregistered today.
    count: 0
  },
  {
    file: 'app/src/main/services/distill/contract.ts',
    symbol: 'buildCaseDistillPrompt section scaffolding (9 strings)',
    reason:
      'Section headers carrying instructions; registering them individually means restructuring the template assembly.',
    plannedIn: 'Plan 3',
    // Empirically 1: the scanner finds exactly one qualifying literal in this file (the
    // "# References (full current content ...)" section-header block) that isn't registered.
    count: 1
  },
  {
    file: 'app/src/main/services/refSync/distill.ts',
    symbol: 'buildDistillPrompt section scaffolding',
    reason: 'Same as the case-distill scaffolding.',
    plannedIn: 'Plan 3',
    // Empirically 0: the one qualifying literal the scanner finds in this file is
    // DISTILL_CONTRACT, which is already registered.
    count: 0
  },
  {
    file: 'app/src/main/services/jiraCases.ts',
    symbol: 'COMMENTS_BANNER',
    reason:
      'Threading a resolver through commentsMarkdown reaches two call sites and their callers; deferred to keep Plan 1 bounded.',
    plannedIn: 'Plan 3',
    // Empirically 1: the scanner finds exactly one qualifying literal in this file
    // (COMMENTS_BANNER, the "> **Provenance notice:** ..." string) that isn't registered.
    count: 1
  },
  {
    file: 'app/src/main/index.ts',
    symbol: 'panel-capture synthesized user message',
    reason: 'Staged as a composer draft, not sent; belongs with the other synthesized entries.',
    plannedIn: 'Plan 3',
    // Empirically 0: app/src/main/index.ts is not in coverage.test.ts's SCANNED list, so the
    // scan never reads it and can never attribute a literal to it — the true count is 0.
    count: 0
  },
  {
    file: 'app/src/main/services/caseService.ts',
    symbol: 'claudeMdTemplate header (slug/title/jira/opened + workspaces markers)',
    reason:
      'Data interpolation and the machine-managed argus:workspaces markers, not instruction text. The rules block IS registered.',
    plannedIn: 'n/a — not a prompt',
    // Empirically 1: the scanner finds exactly one qualifying literal in this file
    // (CASE_WORKING_RULES). It IS registered at runtime (generated-files.case-working-rules),
    // but the scanner's literal-vs-registered string match fails on this one because the raw
    // source keeps escaped backticks (\`) that the compiled runtime string does not, so the
    // scanner's substring comparison misses — a pre-existing scanner quirk, not a real gap.
    count: 1
  }
]
