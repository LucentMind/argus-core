export type TourTarget = 'composer' | 'settings-memory' | 'settings-library' | 'settings-team'

export interface TourStep {
  key: 'memory' | 'skills' | 'references' | 'hivemind'
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

export const TOUR_STEPS: TourStep[] = [
  {
    key: 'memory',
    title: 'Memory',
    target: 'composer',
    view: 'case',
    narration:
      'Argus remembers durable facts across cases. Send this prompt and approve the memory write - then I will show you where it is stored.',
    suggestedPrompt:
      'Remember for future cases: bearing-discontinuity errors in nav.fusion usually follow an IMU bearing drift warning.',
    explain: '',
    reveal: {
      watchTool: 'mcp__argus__write_memory',
      target: 'settings-memory',
      view: 'settings',
      narration:
        'Here is the topic the agent just stored. Argus recalls these durable facts in future cases, no re-explaining.'
    }
  },
  {
    key: 'skills',
    title: 'Skills',
    target: 'settings-library',
    view: 'settings',
    narration:
      'Packs bring versioned skills the agent runs on your evidence. The Library lists every skill and reference the agent can use.',
    explain: ''
  },
  {
    key: 'references',
    title: 'References',
    target: 'settings-library',
    view: 'settings',
    narration:
      "References sync docs from Confluence so the agent can cite your team's knowledge. Synced references live in the Library beside your skills.",
    requiresIntegration: 'confluence',
    explain:
      'References sync documentation from Confluence for the agent to cite. Connect Confluence in Settings > Connectors to enable it.'
  },
  {
    key: 'hivemind',
    title: 'HiveMind',
    target: 'settings-team',
    view: 'settings',
    narration:
      "HiveMind shares skills and reference docs with your team via a git repo. Browse and install your team's shared content here, or share your own from the Library — nothing is pushed without your confirmation.",
    requiresIntegration: 'hive',
    explain:
      'HiveMind shares skills and reference docs with your team through a git repo. Set a repo in Settings > Team to enable it.'
  }
]
