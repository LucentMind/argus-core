export type TourTarget =
  | 'composer'
  | 'settings-memory'
  | 'settings-skills'
  | 'settings-references'
  | 'settings-hivemind'

export interface TourStep {
  key: 'memory' | 'skills' | 'references' | 'hivemind'
  title: string
  target: TourTarget
  view: 'case' | 'settings'
  narration: string
  suggestedPrompt?: string
  requiresIntegration?: 'confluence' | 'hive'
  explain: string
}

export const TOUR_STEPS: TourStep[] = [
  {
    key: 'memory',
    title: 'Memory',
    target: 'composer',
    view: 'case',
    narration:
      'Argus remembers durable facts across cases. Send this prompt, then open Settings > Memory to see the new topic.',
    suggestedPrompt:
      'Remember for future cases: bearing-discontinuity errors in nav.fusion usually follow an IMU bearing drift warning.',
    explain: ''
  },
  {
    key: 'skills',
    title: 'Skills',
    target: 'settings-skills',
    view: 'settings',
    narration:
      'Packs bring versioned skills the agent runs on your evidence. These are the skills available for this case.',
    explain: ''
  },
  {
    key: 'references',
    title: 'References',
    target: 'settings-references',
    view: 'settings',
    narration:
      'References sync docs from Confluence so the agent can cite your teams knowledge. Here are your synced references.',
    requiresIntegration: 'confluence',
    explain:
      'References sync documentation from Confluence for the agent to cite. Connect Confluence in Settings > Connectors to enable it.'
  },
  {
    key: 'hivemind',
    title: 'HiveMind',
    target: 'settings-hivemind',
    view: 'settings',
    narration:
      'HiveMind shares skills and memory with your team via a git repo. You can preview a share here - nothing is pushed without your confirmation.',
    requiresIntegration: 'hive',
    explain:
      'HiveMind shares skills and memory with your team through a git repo. Set a repo in Settings > HiveMind to enable it.'
  }
]
