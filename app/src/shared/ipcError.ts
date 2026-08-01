/**
 * Undoes Electron's IPC error re-wrap. Pure — no `node:*` or Electron imports (see the
 * shared/ constraint), so it is unit-testable and safe to import from the preload.
 *
 * `ipcRenderer.invoke` does not reject with the error main threw. It rejects with a
 * brand-new plain Error (read out of the shipped electron 39.8.10 binary):
 *
 *     async invoke(e, ...t) {
 *       const { error: r, result: o } = await i.invoke(a, e, t)
 *       if (r) throw new Error(`Error invoking remote method '${e}': ${r}`)
 *       return o
 *     }
 *
 * Two consequences drive everything here:
 *
 *  1. `${r}` is the main-process error ALREADY stringified, so the text arrives with the
 *     channel name in front and a redundant `Error:` class tag in the middle — e.g.
 *     `Error invoking remote method 'review:compose-run-prompt': Error: No pull request is
 *     bound to this case.` Both halves are plumbing; only the sentence a developer actually
 *     wrote is fit for a user to read.
 *  2. The original error's class, stack and custom properties are DESTROYED by the re-wrap.
 *     Nothing machine-readable survives the hop, which is why expected, recoverable states
 *     must be modelled as typed results from the handler (see reviewRunCompose.ts) rather
 *     than as thrown errors the renderer tries to recognise by matching this string.
 *
 * This runs at the preload boundary for every channel, so no handler's message can leak the
 * wrapper regardless of which of the ~190 channels it came from.
 */

/** `Error invoking remote method '<channel>': ` — channel names never contain a quote. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*': /

/**
 * A leading `Error: ` / `TypeError: ` / `FooError: ` class tag. Stripped ONLY after the
 * wrapper matched: `new Error('x').message` is `'x'`, never `'Error: x'`, so outside the
 * wrapper a leading `Error: ` is text the author chose to write and is left alone.
 */
const CLASS_TAG = /^(?:[A-Za-z_$][\w$]*)?Error: /

/** The author-written sentence inside an `ipcRenderer.invoke` rejection message. */
export function cleanIpcErrorMessage(message: string): string {
  if (!IPC_WRAPPER.test(message)) return message
  const inner = message.replace(IPC_WRAPPER, '').replace(CLASS_TAG, '')
  // A wrapper around nothing tells the user less than the raw string does — keep the raw one.
  return inner.length > 0 ? inner : message
}
