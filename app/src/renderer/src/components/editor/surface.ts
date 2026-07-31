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
  /** Put the cursor on a 1-indexed line, scroll it into view, and take focus. Out-of-range lines
   *  are clamped, never thrown. */
  goToLine(line: number): void
  focus(): void
}

export interface CursorInfo {
  /** 1-indexed. */
  line: number
  /** 1-indexed. */
  col: number
  /** Characters in the main selection; 0 when it is a bare cursor. */
  selected: number
}
