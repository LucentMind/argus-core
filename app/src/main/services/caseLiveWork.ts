import type { DatabaseSync } from 'node:sqlite'
import type { LiveWorkReason } from './caseArchive'
import { runningRoutineForCase } from './routines/runs'

/**
 * Is anything writing into this case right now, and if so what must the user close?
 *
 * This is what `ArchiveDeps.liveWorkReason` is bound to in `main/index.ts`. It lives here, in
 * its own module with injected suppliers, rather than as a closure inside the IPC handler,
 * because a handler registered inline in `registerIpc()` cannot be invoked from a test
 * (main/index.ts imports `electron` at module scope — see routinesIpc.test.ts). Everything worth
 * getting wrong is therefore on this side of the seam.
 *
 * THREE SOURCES, and none of them is redundant:
 *
 *  1. `busyCaseSlugs()` — the foreground chats mid-TURN. See `busyCaseSlugsOf` below for why
 *     this is not simply "every entry in the session map".
 *  2. `runningRoutineForCase` — the routine run tables. A routine's BACKGROUND session never
 *     enters AgentService's map (registry.ts's `getOrCreate` guard; sessionStore.ts's
 *     `createSession` comment states it outright), so a check built only on (1) reports "idle"
 *     while a routine is actively writing evidence, a transcript and turns into the case. That
 *     is precisely the work archiving must not seal a bundle underneath.
 *  3. `openExternalApps()` — editors and terminals spawned into the case directory by
 *     ExternalAppHost. These write FILES, and they do it entirely outside the app: they hold no
 *     database handle, so `assertCaseWritable` never sees them and the freeze does not stop
 *     them either. Neither the check nor the freeze can cover an external process, so the only
 *     honest thing to do is refuse while one is open and say which one.
 *
 * WHAT THIS IS NOT. It is check-then-act: it runs before `archiveCase` takes the freeze, so it
 * cannot see work that STARTS in the window between the check and the freeze. Closing that
 * window is `caseFreeze.ts`'s job — `assertCaseWritable` is wired into the ingest, scan,
 * extraction and session-creation paths and refuses a frozen case outright, which is the actual
 * safety property (for in-app writes; see (3) for the one category it cannot reach). This
 * function is a courtesy refusal for the ordinary case, so the user is told "finish your work
 * first" instead of watching an archive fight a running agent. Do not upgrade its description
 * into a guarantee it does not provide.
 *
 * Returns a sentence completing "Case <slug> …", or null when the case is idle.
 */
export function caseLiveWorkReason(
  db: DatabaseSync,
  slug: string,
  deps: {
    busyCaseSlugs: () => string[]
    openExternalApps: () => Array<{ packId: string; windowId: string }>
  }
): LiveWorkReason {
  if (deps.busyCaseSlugs().includes(slug)) {
    return 'has an agent session still running. Stop it before archiving, so nothing is written after the bundle is sealed.'
  }
  if (runningRoutineForCase(db, slug) !== null) {
    return 'has a routine run still working on it. Wait for that run to finish before archiving, so nothing is written after the bundle is sealed.'
  }
  const apps = deps.openExternalApps()
  if (apps.length > 0) {
    const named = apps.map((a) => `${a.packId}/${a.windowId}`).join(', ')
    return `has an external app open in its folder (${named}). Close it before archiving — it writes files directly and the archive freeze cannot stop it.`
  }
  return null
}

/**
 * The foreground half of the check: cases with a turn IN FLIGHT.
 *
 * `states()` maps EVERY entry in AgentService's session map, and an entry is added on the first
 * `send()` and removed only by an explicit stop, a driver self-exit, or the LRU reap once
 * `maxSessions` (default 3) is exceeded. There is no idle timer, and `state` is
 * `'running' | 'dead'` — PROCESS liveness, not turn activity. So mapping `states()` unfiltered
 * would report "busy" for every case whose chat has ever been used since launch, and the
 * ordinary flow (investigate a case, finish, archive it) could never be archived at all: with
 * the default `maxSessions` the last three cases touched would be permanently unarchivable
 * until restart, and nothing in the UI lets a user stop an idle session to comply.
 *
 * `activeTurn` (session.ts) is the turn flag, and it is the vocabulary this codebase already
 * uses for exactly this question elsewhere — `getBusyOwners` and the updater's `isQuiet` both
 * filter on it. Exported so index.ts binds this ONE definition instead of re-deriving it in a
 * closure no test can reach.
 */
export function busyCaseSlugsOf(agent: {
  states: () => Array<{ caseSlug: string; activeTurn: boolean }>
}): string[] {
  return agent
    .states()
    .filter((s) => s.activeTurn)
    .map((s) => s.caseSlug)
}
