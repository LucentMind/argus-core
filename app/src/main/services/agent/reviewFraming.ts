import type { DatabaseSync } from 'node:sqlite'
import type { AgentDriver } from './driver'
import type { SubagentSupport } from '../../../shared/drivers'
import type { ModeId } from '../../../shared/modes'
import { sessionProvider, sessionMode } from './sessionStore'
import { getCase } from '../caseService'

/**
 * The one rule for "how should this session's review turn be framed" — shared by CaseSession
 * (session.ts's `subagentsForSession`, which decides which layer agents actually get
 * registered on the driver) and the review-run composer (`reviewRunCompose.ts`'s
 * `resolveReviewFraming` below, which decides which framing text the composed turn uses), so
 * the two answer the question through the identical resolution path for the same session
 * instead of each maintaining its own copy of the rule.
 *
 * Before this helper existed they didn't just risk disagreeing — they disagreed by
 * construction. The composer read capability off `sessions.instance_id` alone (ignoring mode
 * entirely) and defaulted to 'promptable' the moment `instance_id` was null — a documented
 * steady state for an unpinned session, not a corrupt row. session.ts's own invariant is mode
 * AND driver support together. So an unpinned session actually running the Claude driver in
 * review mode had the four layer agents genuinely registered (session.ts asked the real
 * resolved driver) while the composed turn ALSO inlined every layer body with its
 * delegate-only "you have no findings tool" contract (the composer asked a static table keyed
 * on a null id) — both framings landing in the same turn.
 *
 * Agents are only ever registered when mode === 'review' AND the driver can host named
 * subagents (session.ts:147-153's invariant) — either half missing means the turn must be
 * framed 'promptable', even on a driver that itself supports 'configurable' in other modes.
 */
export function reviewSubagentSupport(
  mode: ModeId,
  driverSubagents: SubagentSupport
): SubagentSupport {
  return mode === 'review' && driverSubagents === 'configurable' ? 'configurable' : 'promptable'
}

export interface SessionDriverDeps {
  db: DatabaseSync
  /** Resolves the driver for a session pinned to a specific provider instance. Absent ⇒
   *  every session falls back to `resolveDriver`, matching AgentService's own fallback when
   *  `driverForInstance` isn't wired (tests). */
  driverForInstance?: (instanceId: string) => AgentDriver
  /** The live default provider — used for an unpinned session, exactly like
   *  AgentService.resolveDriver() (registry.ts). */
  resolveDriver: () => AgentDriver
}

/**
 * Resolves the AgentDriver a session actually runs on: a session pinned to a provider
 * instance resolves ITS driver; an unpinned session (pre-multi-provider, or a fresh chat
 * before its first re-pin) falls back to the live default provider — the exact rule
 * AgentService.getOrCreate applies (registry.ts). Factored out so any other caller that needs
 * "which driver is THIS session actually on" (the review-run composer, in particular) gets the
 * identical answer without duplicating the fallback logic or constructing a session.
 */
export function driverForSession(deps: SessionDriverDeps, sessionId: number): AgentDriver {
  const pinned = sessionProvider(deps.db, sessionId)
  return pinned?.instanceId && deps.driverForInstance
    ? deps.driverForInstance(pinned.instanceId)
    : deps.resolveDriver()
}

export type ReviewFramingDeps = SessionDriverDeps

/**
 * Throws unless `sessionId` belongs to `caseSlug`. Split out of `resolveReviewFraming` because
 * the ownership question and the subagent-framing question are independent: a composer that
 * produces a single-pass turn (`ciTriageCompose.ts`) needs the guard but has no framing to
 * resolve, and forcing it to supply `resolveDriver` just to reach the guard would be a driver
 * lookup performed for its side effect of throwing.
 *
 * A cross-case session id reaching a composer is a bug in the caller, never a legitimate
 * request — same posture as AgentService.getOrCreate's ownership guard.
 */
export function assertSessionForCase(db: DatabaseSync, caseSlug: string, sessionId: number): void {
  const rec = getCase(db, caseSlug)
  if (!rec) throw new Error(`Unknown case: ${caseSlug}`)
  const owner = db.prepare(`SELECT case_id FROM sessions WHERE id = ?`).get(sessionId) as
    { case_id: number } | undefined
  if (!owner || owner.case_id !== rec.id) {
    throw new Error(`Unknown session ${sessionId} for case ${caseSlug}`)
  }
}

export interface ReviewFraming {
  support: SubagentSupport
}

/**
 * Full framing for a review-run composition. Verifies `sessionId` actually belongs to
 * `caseSlug` first — a cross-case session id reaching here is a bug in the caller, never a
 * legitimate request, same posture as AgentService.getOrCreate's ownership guard
 * (registry.ts:130-140) — then resolves `support` through `driverForSession` +
 * `reviewSubagentSupport` above. Throws on an unknown case or a session that does not belong
 * to it.
 */
export function resolveReviewFraming(
  deps: ReviewFramingDeps,
  caseSlug: string,
  sessionId: number
): ReviewFraming {
  assertSessionForCase(deps.db, caseSlug, sessionId)
  const mode = sessionMode(deps.db, sessionId)
  const driver = driverForSession(deps, sessionId)
  return { support: reviewSubagentSupport(mode, driver.capabilities.subagents) }
}
