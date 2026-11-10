import { composerDraft } from './composerDraft'
import { panelsStore, CHAT_TAB } from './panelsStore'

/** `Correct` (spec 2026-10-26 §9.7, #242 follow-up): put the finding's handle in the composer
 *  and bring the chat forward. Nothing is written and no review state changes until the user
 *  sends — the agent then hears the review-delta note AND the user's words in one turn. */
export function stageCorrection(slug: string, sessionId: number, findingId: number): void {
  composerDraft.set(slug, sessionId, `Finding #${findingId}: `)
  panelsStore.setActiveTab(CHAT_TAB)
}
