/**
 * What the rest of the editor is allowed to do to the document.
 *
 * A separate `.ts` module, not an export from `CodeSurface.tsx`: the repo's
 * `react-refresh/only-export-components` rule lets a component file export nothing but the
 * component and types, and `AssetTab`'s tests mock `CodeSurface` — a mock must not have to
 * re-declare the contract it is standing in for.
 */
export interface SurfaceHandle {
  /** The document as CodeMirror currently holds it. Authoritative; the React mirror can lag it
   *  by a render. */
  getDoc(): string
  /**
   * Replace the whole document in **one transaction**, so it lands in the undo history as a
   * single step (spec §5.2). This is the only way anything outside CodeMirror changes the text:
   * assist accept, "Use disk", "Keep mine", discard draft, create-mode template regeneration.
   */
  setDoc(text: string): void
  /**
   * Put the cursor on a 1-indexed line and scroll it into view. Out-of-range lines are clamped,
   * never thrown — `Text.line(n)` throws past the end of the document.
   *
   * Focus by default, because the problems panel's click-to-line wants it. Restore passes
   * `focus: false`: a tab being restored is not necessarily the tab the user is looking at, and
   * stealing focus into a background tab would move the caret out from under them.
   */
  goToLine(line: number, opts?: { col?: number; focus?: boolean }): void
  focus(): void
  /**
   * Re-measure after the element becomes visible again.
   *
   * Every tab stays mounted and the inactive ones are `display: none` (spec §6.1 as built —
   * see the plan's deviation 3). CodeMirror caches viewport geometry and cannot measure a
   * display-none element, so a tab revealed after a switch comes back with a collapsed
   * viewport: no visible text past the first screenful, and a gutter of the wrong width.
   * Invisible to jsdom, which has no layout at all — asserted by the CDP gate.
   */
  requestMeasure(): void
  /**
   * Scroll to a 0–1 fraction of the document.
   *
   * Imperative rather than a `scrollFraction` **prop** because restore runs from an effect, and
   * driving it through React state would mean a synchronous `setState` in an effect body — which
   * `react-hooks/set-state-in-effect` forbids and this repo does not allow suppressing.
   *
   * `CodeSurface` did carry such a prop (with an `applyingScroll` echo guard) and it never had a
   * caller: `AssetPane` renders the surface without it, and split-preview sync runs the OTHER
   * way — the surface reports `onScrollFraction`, and `PreviewPane` is the one driven by a
   * `scrollFraction` prop. This method is the only way to scroll the editing surface.
   */
  scrollTo(fraction: number): void
}

export interface CursorInfo {
  /** 1-indexed. */
  line: number
  /** 1-indexed. */
  col: number
  /** Characters in the main selection; 0 when it is a bare cursor. */
  selected: number
}
