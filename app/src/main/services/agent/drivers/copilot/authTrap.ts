import { COPILOT_AUTH_ERROR_SUBSTRING } from './normalize'

// The SDK leaks an unhandled promise rejection on an unauthenticated turn that would
// crash the process if untrapped (EVIDENCE §7). Merely being attached, a listener
// suppresses Node's default handling for ALL rejections process-wide — so the trap must
// (a) swallow ONLY auth-shaped rejections (the same failure also arrives as a typed
// `session.error` that drives the auth verdict) and rethrow everything else on a fresh
// tick, where it becomes an uncaughtException and Node's default handling applies again;
// (b) be a single ref-counted process listener, so concurrent Copilot sessions never
// stack duplicate handlers that would each rethrow the same unrelated rejection.
/**
 * True for a write rejection the SDK's own jsonrpc transport leaked after its runtime child
 * went away. When the CLI dies (crash, teardown race, or an unspawnable binary) every queued
 * write rejects `ERR_STREAM_DESTROYED`/`EPIPE` from inside the SDK, unawaited — a flood of
 * unhandled rejections we can neither catch at a call site nor act on.
 *
 * Provenance is checked against the stack, not just the code: an identical error raised by
 * Argus's own streams is a real bug and must keep crashing loudly.
 */
export function isCopilotTransportTeardownError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false
  const code = (reason as NodeJS.ErrnoException).code
  if (code !== 'ERR_STREAM_DESTROYED' && code !== 'ERR_STREAM_WRITE_AFTER_END' && code !== 'EPIPE')
    return false
  return /vscode-jsonrpc|@github[\\/]copilot-sdk/.test(reason.stack ?? '')
}

const authRejectionTrap = (reason: unknown): void => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  // Same check as index.ts's isCopilotAuthErrorMessage, inlined against the shared substring
  // rather than imported, so this module never depends back on index.ts (would be circular).
  if (msg.includes(COPILOT_AUTH_ERROR_SUBSTRING)) return // swallowed: prevents the process crash
  if (isCopilotTransportTeardownError(reason)) return // swallowed: dead-runtime write flood
  setImmediate(() => {
    throw reason instanceof Error ? reason : new Error(msg)
  })
}
let authTrapRefs = 0
export function acquireAuthRejectionTrap(): () => void {
  if (authTrapRefs++ === 0) process.on('unhandledRejection', authRejectionTrap)
  let released = false
  return () => {
    if (released) return
    released = true
    if (--authTrapRefs === 0) process.off('unhandledRejection', authRejectionTrap)
  }
}
