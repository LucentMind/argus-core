// Scenario 15: exit-plan-mode handshake, end-to-end (open question 3 / Task 12e).
// Scenario 12 proved plan mode engages (rpc.mode.set) but the model never COMPLETED a
// plan in the short capped turn, so onExitPlanModeRequest never fired and the live
// ExitPlanModeRequest payload (summary/planContent/actions[]/recommendedAction) went
// uncaptured. Here we give the model a tiny, fully-completable task, an explicit
// instruction to finish planning and exit plan mode, and a large turn budget — then
// APPROVE the exit (mirroring the driver's exitPlanModeDecision v1) so we also capture
// exit_plan_mode.completed. If the handshake fires, this fixture backs EVIDENCE §9b.
import {
  newClient,
  recorder,
  wireAllEvents,
  sandboxDir,
  sandboxGuard,
  stop,
  guarded
} from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('15-exit-plan')
  const client = newClient()
  let exitFired = false
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      onExitPlanModeRequest: (request, invocation) => {
        exitFired = true
        // Capture the full live payload — this is the artifact §9b needs.
        rec('exit-plan-request', { request, invocation })
        // Approve, selecting the runtime's recommended action, exactly as the driver's
        // exitPlanModeDecision() does in production.
        const decision = {
          approved: true,
          ...(request?.recommendedAction ? { selectedAction: request.recommendedAction } : {})
        }
        rec('exit-plan-decision', { decision })
        return decision
      },
      onPermissionRequest: sandboxGuard(rec, (request) => {
        // Reads are fine while planning. Plan mode persists the plan to the infinite-session
        // artifact COPILOT_HOME/session-state/<id>/plan.md; run 1 showed that DENYING that
        // write stalls the model mid-plan and the exit handshake never fires. Approve that one
        // write (it lands in the isolated scratch home, never the sandbox) so the model can
        // finish planning and request exit. Deny any OTHER write to keep the sandbox clean.
        if (request?.kind === 'read') return { kind: 'approve-once' }
        if (request?.kind === 'write' && String(request?.fileName ?? '').replace(/\\/g, '/').includes('/session-state/')) {
          return { kind: 'approve-once' }
        }
        return { kind: 'reject', feedback: 'exit-plan spike: only the plan.md artifact may be written' }
      })
    })
    rec('meta', { sessionId: session.sessionId })
    wireAllEvents(session, rec)

    await guarded(rec, 'mode-set-plan', async () => {
      await session.rpc.mode.set({ mode: 'plan' })
      const mode = await session.rpc.mode.get()
      rec('result', { phase: 'after-set-plan', mode, planModeAccepted: mode === 'plan' })
    })

    await guarded(rec, 'plan-turn', async () => {
      const final = await session.sendAndWait(
        'You are in plan mode. Make a concise plan (2-3 steps) to add a one-line CONTRIBUTORS ' +
          'file to this repo. The plan is trivial and complete — once you have written it, ' +
          'present it and exit plan mode so it can be executed.',
        300000
      )
      rec('result', {
        phase: 'plan-turn',
        exitFired,
        finalContent: final?.data?.content?.slice(0, 600)
      })
    })

    await session.disconnect()
  })
  rec('result', { phase: 'summary', exitFired })
  await stop(client)
}
