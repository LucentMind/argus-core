// Imports no electron: `platform` arrives as a value so the rule is testable without a runtime.

export interface KeepAliveInputs {
  platform: NodeJS.Platform
  /** `settings.general.keepAliveInBackground`. */
  keepAlive: boolean
}

/**
 * Whether closing the last window should leave the process running.
 *
 * Its own function rather than an inline boolean in `window-all-closed` because both ways of
 * getting it wrong are silent: return `true` when it should be `false` and the user is left with
 * an invisible process they never asked for; return `false` when it should be `true` and the
 * routines engine dies with the window while the Settings toggle still claims it is on.
 *
 * macOS is unconditional on purpose — see the spec's §3.3 decision. Argus already never quit on
 * last-window-close there, and every other macOS app behaves the same way; honouring the setting
 * uniformly would mean breaking that convention to make one toggle read consistently.
 */
export function shouldKeepAlive({ platform, keepAlive }: KeepAliveInputs): boolean {
  if (platform === 'darwin') return true
  return keepAlive
}
