import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * A single overlay's claim on the Escape key.
 *
 * `swallow` layers consume Escape without acting — that is how a
 * non-dismissible overlay (SetupWizard) keeps Escape from falling through to a
 * dismissible view underneath it (SettingsView).
 */
export type EscapeLayer =
  { onEscape: () => void; swallow?: false } | { swallow: true; onEscape?: undefined }

/**
 * Entries are boxed so each push owns a stable identity. Popping splices by
 * identity, never by index — overlays unmount in arbitrary order and an
 * index-based pop would remove the wrong entry.
 */
interface Entry {
  /** Always present. A `swallow` layer is one whose handler does nothing. */
  onEscape: () => void
}

const stack: Entry[] = []
let listening = false

function isField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable === true) return true
  // jsdom does not implement `isContentEditable` (it reads back as `undefined`
  // even when the attribute is set), so the property check above never fires
  // under test. Fall back to the raw attribute — real browsers already return
  // early above, so this only changes behavior inside jsdom.
  const attr = el.getAttribute?.('contenteditable')
  return attr === 'true' || attr === ''
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // A focused field owns its own Escape (revert-or-clear, then blur). Deciding
  // by target rather than by propagation is deliberate: these are window
  // listeners, so a React synthetic stopPropagation would not reach us anyway.
  if (isField(e.target)) return
  const top = stack[stack.length - 1]
  if (!top) return
  // Dispatch stops here unconditionally — a swallow layer's handler is a no-op,
  // so "consumes without acting" needs no special case.
  top.onEscape()
}

function ensureListening(): void {
  if (listening) return
  window.addEventListener('keydown', onKeyDown)
  listening = true
}

/** Push a layer. Returns the pop function; calling it twice is a no-op. */
export function pushEscapeLayer(layer: EscapeLayer): () => void {
  ensureListening()
  const entry: Entry = {
    onEscape: layer.swallow === true ? () => {} : layer.onEscape
  }
  stack.push(entry)
  return () => {
    const i = stack.indexOf(entry)
    if (i !== -1) stack.splice(i, 1)
  }
}

/**
 * Registers an escape layer for the lifetime of the calling component.
 *
 * The layer is read through a ref on every keypress and the registration
 * effect has empty deps, so a caller passing a fresh object literal or inline
 * arrow each render — which is the norm, e.g. `onClose={() => setViewer(null)}`
 * — does not re-register. Re-registering would push the layer back to the top
 * of the stack on every render, so a re-rendering *background* overlay would
 * steal Escape from the overlay actually on top.
 *
 * The ref is kept fresh by its own effect (no deps, so it runs after every
 * render) rather than by a plain assignment in the function body: writing to
 * `ref.current` during render is disallowed by the `react-hooks/refs` lint
 * rule, since a ref is not supposed to be touched outside an effect or a
 * handler.
 */
export function useEscapeLayer(layer: EscapeLayer): void {
  const ref = useRef(layer)
  useEffect(() => {
    ref.current = layer
  })
  useEffect(
    () =>
      pushEscapeLayer({
        onEscape: () => {
          const cur = ref.current
          if (cur.swallow !== true) cur.onEscape()
        }
      }),
    []
  )
}

/** Test-only: drop every registered layer between cases. */
export function __resetEscapeLayersForTest(): void {
  stack.length = 0
}

/**
 * Escape inside a transient field (search, filter, jump, cut): clear it if it
 * has content, otherwise hand focus back to the shell so the next Escape
 * reaches the escape layer and closes the overlay.
 *
 * Lives here rather than inline at each call site so the two-stage rule is
 * defined once — it is applied at eleven fields and would otherwise drift.
 */
export function transientFieldEscape(
  e: ReactKeyboardEvent<HTMLElement>,
  isEmpty: boolean,
  clear: () => void
): void {
  if (e.key !== 'Escape') return
  if (isEmpty) e.currentTarget.blur()
  else clear()
}

/**
 * Escape inside a field with nothing to clear (a `<select>`, a jump box):
 * hand focus back to the shell.
 *
 * This is not cosmetic. Focus stays on a `<select>` after an option is chosen,
 * so without it Escape would be swallowed forever and the view unclosable by
 * keyboard.
 */
export function blurOnEscape(e: ReactKeyboardEvent<HTMLElement>): void {
  if (e.key === 'Escape') e.currentTarget.blur()
}
