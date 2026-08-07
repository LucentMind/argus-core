import type { DatabaseSync } from 'node:sqlite'
import { runBackgroundTurn, type BackgroundTurnResult } from '../agent/background'
import type { AgentDriver } from '../agent/driver'
import type { SessionMirrorLike } from '../agent/session'
import { materializeSessionSkills } from '../agent/skillsResolver'
import { assembleMode } from '../agent/modeAssembly'
import { sessionMode } from '../agent/sessionStore'
import type { Detection } from '../packs/detection'
import type { AgentEvent } from '../../../shared/agent-events'
import type { AgentAccess } from '../../../shared/agentAccess'
import type { RiskLevel } from '../../../shared/connectors'
import type { RoutineTurnRequest } from './service'

// Deliberately imports NO electron (same rule as service.ts and agent/background.ts): every
// host-owned value arrives as an injected thunk, so a future headless server can bind the same
// seam. This module exists so the binding it performs is TESTABLE — it used to be an inline
// closure in index.ts, which imports electron at module scope and therefore cannot be loaded by
// any runtime test.

export interface RoutineTurnRunnerDeps {
  db: DatabaseSync
  argusHome: string
  detection: Detection
  skillsRoots: string[]
  /** Driver lookup by kind. Production passes `getDriverByKind`, which FALLS BACK silently —
   *  see the mismatch guard below for why that fallback must not be allowed through. */
  driverFor: (kind: string) => AgentDriver
  /** Live agent-access overrides (skills/memory). Required, not optional: defaulting it is
   *  exactly the bug this seam exists to prevent — `defaultAgentAccess()` re-enables every
   *  memory topic the user disabled. */
  agentAccess: () => AgentAccess
  toolRisk?: () => Record<string, RiskLevel>
  packCliNames?: () => string[]
  resolvePrompt?: (id: string) => string
  onEvent?: (e: AgentEvent) => void
  mirrorFactory?: (caseSlug: string, sessionId: number) => SessionMirrorLike
}

/**
 * Binds a `RoutinesService.runTurn`: resolve the driver, assemble the session-shape deps an
 * interactive session would get, then run one unattended background turn.
 *
 * DRIVER-KIND MISMATCH IS FATAL. `getDriverByKind` returns the Claude driver for ANY
 * unregistered kind, and `driverKind` has already been written into the session row by the
 * time we get here (service.ts). So a hand-edited `config/routines.json` with a typo'd
 * `"coplilot"` would record `coplilot` on the row, show `coplilot` on the UI chip, and then
 * execute on Claude — with a Copilot model slug if `model` is set. The old behaviour was a
 * `console.warn` into a terminal no user ever sees; throwing instead routes the truth through
 * `RoutinesService.execute`'s try/catch, which records it as a `failed` run whose `error` the
 * run-history UI already renders.
 *
 * SKILLS AND ACCESS, BUT NOT PERSONA. `assembleMode` is called for its skill half only —
 * `enabledSkills` (the driver allowlist) and `skillIndex` (how the model learns those skills
 * exist; without it, passing the allowlist accomplishes nothing). Its persona half is
 * discarded, and `packFragments` is empty, because a persona for assisting a human in defect
 * triage is not a persona for unattended automation: inheriting the interactive one would be
 * wrong rather than merely incomplete. The automation-side identity comes from the unattended
 * preamble `RoutinesService` prepends to the prompt. `contributeBack` is `false` for the same
 * reason — it only ever adds a persona nudge, which is discarded here anyway.
 */
export function createRoutineTurnRunner(
  deps: RoutineTurnRunnerDeps
): (req: RoutineTurnRequest) => Promise<BackgroundTurnResult> {
  return ({ driverKind, ...params }) => {
    const driver = deps.driverFor(driverKind)
    if (driver.kind !== driverKind) {
      throw new Error(
        `Unknown driver kind "${driverKind}": the run would have executed on ` +
          `"${driver.kind}" while the session row and the UI both claim "${driverKind}". ` +
          `Fix driverKind in config/routines.json.`
      )
    }

    const access = deps.agentAccess()
    // Same call AgentService.getOrCreate makes, and it is not just a read: it materializes the
    // case's skill junctions, so the allowlist below and what is actually on disk agree.
    const resolvedSkills = materializeSessionSkills(deps.argusHome, params.caseSlug, access)
    const assembled = assembleMode({
      mode: sessionMode(deps.db, params.sessionId),
      resolvedSkills,
      packFragments: [],
      contributeBack: false,
      resolve: deps.resolvePrompt
    })

    return runBackgroundTurn(
      {
        db: deps.db,
        argusHome: deps.argusHome,
        detection: deps.detection,
        skillsRoots: deps.skillsRoots,
        driver,
        enabledSkills: assembled.enabledSkills,
        skillIndex: assembled.skillIndex,
        packCliNames: deps.packCliNames?.() ?? [],
        agentAccess: deps.agentAccess,
        toolRisk: deps.toolRisk,
        onEvent: deps.onEvent,
        mirrorFactory: deps.mirrorFactory
      },
      params
    )
  }
}
