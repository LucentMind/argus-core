/** How a driver branches a conversation: `native` = the provider slices its own transcript
 *  (Claude: forkSession / resumeSessionAt); `digest` = a fresh provider session that receives
 *  Argus's history digest on its first send. */
export type Branching = 'native' | 'digest'

export const TURN_STATUS_REWOUND = 'rewound'

/**
 * `findings.review_reason` on a finding a rewind retracted. Two modules have to agree on this
 * string or the feature quietly half-works: `sessionBranch.ts` writes it, and `distill/input.ts`
 * filters findings carrying it OUT of the rejected-finding learning signal (spec §7.1 — the
 * user rewound the path, they did not judge the finding). A typo on either side is invisible:
 * the rewind still succeeds and distillation still runs, it just learns from a rejection the
 * user never made. Same value as TURN_STATUS_REWOUND, deliberately a separate constant — one
 * names a turn's status, the other a finding's reason, and they are free to diverge.
 */
export const REWIND_REVIEW_REASON = 'rewound'

/** A turn the user rewound away. `toTurnId` is the anchor kept; `at` is when. */
export interface RewoundTurn {
  turnId: number
  toTurnId: number
  at: string
}

/** Where a forked session came from. `inheritedTurns` = how many of the fork's own turn rows
 *  were copied from the parent; the transcript divider sits after that many turns.
 *
 *  `branching` is what the fork ACTUALLY got, recorded at fork time (`sessions.forked_branching`)
 *  — not a property of the driver, and not recomputable later. A Claude session forks natively
 *  only when the anchor turn still carries a `provider_anchor_id`, which an inherited turn (V2)
 *  and every turn surviving a native rewind (V14) do not; and the cursors that made it native
 *  are deliberately not restored from an archive. The divider is permanent, so the fact has to
 *  be stored, not derived. */
export interface ForkOrigin {
  sessionId: number
  turnId: number
  inheritedTurns: number
  branching: Branching
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
