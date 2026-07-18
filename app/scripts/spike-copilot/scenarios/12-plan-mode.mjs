// Scenario 12: plan-mode analogue.
// The SDK DOES model a plan mode: SessionMode = "interactive" | "plan" |
// "autopilot", set via session.rpc.mode.set({mode}), read via .get(), with an
// onExitPlanModeRequest handler and exit_plan_mode.requested/completed events.
// This scenario proves the surface empirically: read the initial mode, switch
// to "plan", read it back, register the exit-plan handler, and run one tiny turn
// to see whether a plan-mode turn suppresses write permission prompts / emits an
// exit_plan_mode request.
import { newClient, recorder, wireAllEvents, sandboxDir, sandboxGuard, stop, guarded } from '../lib.mjs'

export default async function run() {
  const { rec } = recorder('12-plan-mode')
  const client = newClient()
  await guarded(rec, 'scenario', async () => {
    await client.start()
    const session = await client.createSession({
      workingDirectory: sandboxDir(),
      streaming: true,
      onExitPlanModeRequest: (request, invocation) => {
        rec('exit-plan-request', { request, invocation })
        // Do not approve leaving plan mode — keep the turn read-only.
        return { approved: false, feedback: 'spike: stay in plan mode' }
      },
      onPermissionRequest: sandboxGuard(rec, (request) => {
        // Deny any write so plan mode cannot mutate the sandbox.
        if (request?.kind === 'read') return { kind: 'approve-once' }
        return { kind: 'reject', feedback: 'plan-mode spike: read-only' }
      })
    })
    rec('meta', { sessionId: session.sessionId })
    wireAllEvents(session, rec)

    await guarded(rec, 'mode-get-initial', async () => {
      const mode = await session.rpc.mode.get()
      rec('result', { phase: 'initial-mode', mode })
    })
    await guarded(rec, 'mode-set-plan', async () => {
      await session.rpc.mode.set({ mode: 'plan' })
      const mode = await session.rpc.mode.get()
      rec('result', { phase: 'after-set-plan', mode, planModeAccepted: mode === 'plan' })
    })

    await guarded(rec, 'plan-turn', async () => {
      const final = await session.sendAndWait(
        'Come up with a short plan to add a LICENSE file to this repo. Do not make any changes yet.',
        120000
      )
      rec('result', { phase: 'plan-turn', finalContent: final?.data?.content?.slice(0, 400) })
    })
    await session.disconnect()
  })
  await stop(client)
}
