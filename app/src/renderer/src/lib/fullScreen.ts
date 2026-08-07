/**
 * Stamps `data-fullscreen` on `<html>` while the window is in OS full screen, so CSS can drop
 * chrome that only exists to stay clear of the OS's own window controls.
 *
 * One consumer today: `:root[data-platform='darwin'][data-fullscreen='true'] .argus-header-inset`
 * in main.css. macOS puts the traffic lights at the LEFT of the title bar, so the header reserves
 * ~78px there — but full screen hides the cluster entirely, leaving that reservation as a gap the
 * wordmark is pushed off by. On win32/linux the caption buttons are ours and sit on the right, so
 * nothing there depends on this; the attribute is still stamped on every platform because the
 * platform scoping belongs in the one rule that cares, not smeared across the transport.
 *
 * Told by main rather than observed here, and this is the part with no alternative: `env(
 * titlebar-area-x)` is not published on darwin (see the platform-floor comments in main.css), and
 * the DOM `fullscreenchange` event covers only the Fullscreen API — the green button, ⌃⌘F and the
 * menu item never reach the renderer.
 *
 * Its own module rather than a member of `uiStore`: this is window state owned by the OS, not
 * persisted preference state, and nothing renders off it (the attribute is the whole output).
 */

/** Attaches the listener and seeds the current value. Returns an unsubscribe. */
export function watchFullScreen(): () => void {
  const api = window.argus?.window
  let alive = true
  let sawEvent = false

  const apply = (full: boolean): void => {
    if (full) document.documentElement.setAttribute('data-fullscreen', 'true')
    else document.documentElement.removeAttribute('data-fullscreen')
  }

  // Subscribe BEFORE the initial read is issued, so a transition landing inside that await is not
  // dropped. `sawEvent` then keeps the late-resolving seed — which describes the state as of the
  // request, not of its reply — from overwriting the fresher event value.
  const off = api?.onFullScreenChanged((full) => {
    if (!alive) return
    sawEvent = true
    apply(full)
  })
  void api?.isFullScreen().then((full) => {
    if (alive && !sawEvent) apply(full)
  })

  return () => {
    alive = false
    off?.()
  }
}
