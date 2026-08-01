import { createContext, useContext } from 'react'

/**
 * Where the **active** asset pane hangs its action buttons: an element in the editor window's
 * title-bar strip, published downward so `AssetPane` can `createPortal` into it.
 *
 * A slot rather than lifted state, deliberately. Collapsing the editor window to one row of
 * chrome means the view-mode toggle and Save have to render up in the drag strip, but every input
 * they depend on — `busy`, `proposed`, `readOnly`, the view-mode pref, `onSave` — belongs to the
 * pane. Hoisting all of that into `EditorApp` would move state across a component boundary that
 * has a documented history of identity/memo bugs (see `TabPane`'s comment in EditorApp.tsx);
 * portalling moves only the DOM position and leaves ownership exactly where it was.
 *
 * `null` means "no slot" — the pane then renders no actions at all. That is the honest answer
 * outside the editor window (this context has no provider anywhere else) rather than a silent
 * fallback that would put the buttons somewhere nobody designed.
 */
export const PaneActionSlotContext = createContext<HTMLElement | null>(null)

export function usePaneActionSlot(): HTMLElement | null {
  return useContext(PaneActionSlotContext)
}
