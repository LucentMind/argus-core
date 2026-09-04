/** How a driver branches a conversation: `native` = the provider slices its own transcript
 *  (Claude: forkSession / resumeSessionAt); `digest` = a fresh provider session that receives
 *  Argus's history digest on its first send. */
export type Branching = 'native' | 'digest'

export const TURN_STATUS_REWOUND = 'rewound'

/** A turn the user rewound away. `toTurnId` is the anchor kept; `at` is when. */
export interface RewoundTurn {
  turnId: number
  toTurnId: number
  at: string
}

/** Where a forked session came from. `inheritedTurns` = how many of the fork's own turn rows
 *  were copied from the parent; the transcript divider sits after that many turns. */
export interface ForkOrigin {
  sessionId: number
  turnId: number
  inheritedTurns: number
}

export interface RewindPreview {
  anchorTurnId: number
  branching: Branching
  /** Turns that will be greyed, oldest first. `userText` is the turn's prompt. */
  tail: { turnId: number; userText: string }[]
  findingsToRetract: { id: number; summary: string }[]
  /** Findings in the tail that stay as they are, with why. */
  findingsStaying: { id: number; summary: string; reason: 'accepted' | 'already-retracted' }[]
  /** Irreversible tool calls in the tail (external posts, status changes, …), by tool. */
  externalActions: { tool: string; count: number }[]
  files:
    | { kind: 'native'; restored: string[]; skipped: number; error?: string }
    | { kind: 'counts'; writes: { tool: string; count: number }[] }
}

export interface RewindResult {
  /** The first discarded turn's prompt, for the composer. */
  composerText: string
}
