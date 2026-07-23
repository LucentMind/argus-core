export type TourTarget =
  'composer' | 'settings-memory' | 'settings-proposals' | 'settings-library' | 'settings-team'

export interface TourStep {
  key: 'memory' | 'proposals' | 'skills' | 'hivemind'
  title: string
  target: TourTarget
  view: 'case' | 'settings'
  narration: string
  suggestedPrompt?: string
  requiresIntegration?: 'confluence' | 'hive'
  explain: string
  /**
   * Optional second phase: once the agent finishes the named tool call on the
   * sample case, the companion re-points to `target` in `view` and swaps in
   * `narration` — used to guide the user from staging a prompt to seeing its
   * result (e.g. Memory: send the prompt, then spotlight Settings > Memory).
   */
  reveal?: {
    watchTool: string
    target: TourTarget
    view: 'case' | 'settings'
    narration: string
  }
}

/**
 * The tour is a single contribute-back loop driven by ONE staged prompt:
 * the agent records a durable memory AND drafts a skill proposal, then the
 * tour walks that skill through its lifecycle —
 *
 *   prompt → Memory (the fact) → Proposals (accept the skill) →
 *   Library (where it landed + share) → HiveMind (pull in others' shared work)
 *
 * which closes the loop. References sync is no longer its own stop; those
 * docs live in the Library beside skills.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    key: 'memory',
    title: 'Memory & skills',
    target: 'composer',
    view: 'case',
    narration:
      'Argus turns what it learns into durable memory and reusable skills. Send this prompt: it records a cross-case fact and drafts a skill for you to review — then I will show you where each one goes.',
    suggestedPrompt:
      'We keep seeing bearing-discontinuity errors in nav.fusion after an IMU bearing-drift warning. Remember this pattern for future cases, and draft a reusable skill that flags it so I can review and add it to my library.',
    explain: '',
    reveal: {
      watchTool: 'mcp__argus__write_memory',
      target: 'settings-memory',
      view: 'settings',
      narration:
        'Here is the durable fact the agent just stored — Argus recalls these in future cases, no re-explaining. It also drafted a skill from the same prompt; let us go accept it.'
    }
  },
  {
    key: 'proposals',
    title: 'Proposals',
    target: 'settings-proposals',
    view: 'settings',
    narration:
      'The agent drafted that skill as an inert proposal — nothing enters your library without your say. Review it here and Accept to add it.',
    explain: ''
  },
  {
    key: 'skills',
    title: 'Library',
    target: 'settings-library',
    view: 'settings',
    narration:
      'Accepted skills land here in your Library, versioned and ready for the agent to run on your evidence. From here you can also share a skill with your team.',
    explain: ''
  },
  {
    key: 'hivemind',
    title: 'HiveMind',
    target: 'settings-team',
    view: 'settings',
    narration:
      "HiveMind is the other half of sharing: pull in skills and reference docs teammates have published to your team's git repo — nothing is pushed or pulled without your confirmation. That closes the loop: learn, propose, accept, share.",
    requiresIntegration: 'hive',
    explain:
      'HiveMind shares skills and reference docs with your team through a git repo. Set a repo in Settings > Team to enable it.'
  }
]
