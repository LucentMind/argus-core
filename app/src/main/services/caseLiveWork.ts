import type { DatabaseSync } from 'node:sqlite'
import { runningRoutineForCase } from './routines/runs'

/**
 * Is anything writing into this case right now?
 *
 * This is what `ArchiveDeps.hasLiveWork` is bound to in `main/index.ts`. It lives here, in its
 * own module with an injected live-slug supplier, rather than as a closure inside the IPC
 * handler, because a handler registered inline in `registerIpc()` cannot be invoked from a test
 * (main/index.ts imports `electron` at module scope — see routinesIpc.test.ts). Everything worth
 * getting wrong is therefore on this side of the seam.
 *
 * TWO SOURCES, and the second one is the whole reason this is not a one-liner:
 *
 *  1. `liveCaseSlugs()` — AgentService's live session map, the foreground chats a user is
 *     talking to.
 *  2. `runningRoutineForCase` — the routine run tables. A routine's BACKGROUND session never
 *     enters AgentService's map (registry.ts's `getOrCreate` guard; sessionStore.ts's
 *     `createSession` comment states it outright), so a check built only on (1) reports "idle"
 *     while a routine is actively writing evidence, a transcript and turns into the case. That
 *     is precisely the work archiving must not seal a bundle underneath.
 *
 * WHAT THIS IS NOT. It is check-then-act: it runs before `archiveCase` takes the freeze, so it
 * cannot see work that STARTS in the window between the check and the freeze. Closing that
 * window is `caseFreeze.ts`'s job — `assertCaseWritable` is wired into the ingest, scan,
 * extraction and session-creation paths and refuses a frozen case outright, which is the actual
 * safety property. This function is a courtesy refusal for the ordinary case, so the user is
 * told "finish your work first" instead of watching an archive fight a running agent. Do not
 * upgrade its description into a guarantee it does not provide.
 */
export function caseHasLiveWork(
  db: DatabaseSync,
  slug: string,
  deps: { liveCaseSlugs: () => string[] }
): boolean {
  if (deps.liveCaseSlugs().includes(slug)) return true
  return runningRoutineForCase(db, slug) !== null
}
