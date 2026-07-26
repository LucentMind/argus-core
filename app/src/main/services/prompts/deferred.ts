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
}

export const DEFERRED_PROMPTS: readonly DeferredPrompt[] = [
  {
    file: 'app/src/main/services/agent/nativeTools.ts',
    symbol: 'model-facing tool return / steering strings (~12)',
    reason:
      'Returned as tool output rather than declared as prompt text; needs per-string ids and a handler-level seam.',
    plannedIn: 'Plan 3'
  },
  {
    file: 'app/src/main/services/distill/contract.ts',
    symbol: 'buildCaseDistillPrompt section scaffolding (9 strings)',
    reason:
      'Section headers carrying instructions; registering them individually means restructuring the template assembly.',
    plannedIn: 'Plan 3'
  },
  {
    file: 'app/src/main/services/refSync/distill.ts',
    symbol: 'buildDistillPrompt section scaffolding',
    reason: 'Same as the case-distill scaffolding.',
    plannedIn: 'Plan 3'
  },
  {
    file: 'app/src/main/services/jiraCases.ts',
    symbol: 'COMMENTS_BANNER',
    reason:
      'Threading a resolver through commentsMarkdown reaches two call sites and their callers; deferred to keep Plan 1 bounded.',
    plannedIn: 'Plan 3'
  },
  {
    file: 'app/src/main/index.ts',
    symbol: 'panel-capture synthesized user message',
    reason: 'Staged as a composer draft, not sent; belongs with the other synthesized entries.',
    plannedIn: 'Plan 3'
  },
  {
    file: 'app/src/main/services/caseService.ts',
    symbol: 'claudeMdTemplate header (slug/title/jira/opened + workspaces markers)',
    reason:
      'Data interpolation and the machine-managed argus:workspaces markers, not instruction text. The rules block IS registered.',
    plannedIn: 'n/a — not a prompt'
  }
]
