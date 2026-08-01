import { keymap } from '@codemirror/view'
import { defaultKeymap, historyKeymap } from '@codemirror/commands'
import { openSearchPanel, searchKeymap } from '@codemirror/search'
import { closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { markdownKeymap } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'

/** The commands the surface itself cannot implement, because they change React state. */
export interface SurfaceCommands {
  save: () => void
  /** `+1` / `-1` steps; `0` resets to the default. */
  changeFontSize: (delta: number) => void
  toggleWrap: () => void
  cycleViewMode: () => void
  /** Ctrl+click on a resolvable markdown link. The file is a reference filename, already
   *  resolved against the known set (see extensions/links.ts). */
  openLink: (file: string) => void
}

/**
 * Spec §5.7.
 *
 * Taken as a **ref**, not a value: the commands close over React state and get new identities on
 * every render, and rebuilding the keymap on every keystroke would mean rebuilding the extension
 * — which discards nothing here, but the same mistake one facet over discards undo history. Read
 * at press time instead.
 *
 * `Tab` is left on CodeMirror's default (move focus). `@codemirror/commands` ships `indentWithTab`
 * precisely because binding Tab traps keyboard users in the editor, and markdown gains nothing
 * from it. `Escape` keeps the default keymap's `simplifySelection` and closes the find panel —
 * "Esc is inert" in §5.7 means it does not close the window, and nothing here makes it.
 *
 * `defaultKeymap` is last so anything above it wins: `Mod-s` would otherwise never be seen.
 *
 * **A known, deliberate exception to the registry's `enabled` gate (spec §6.4).** Every chord
 * bound here — `Mod-s`, `Mod-±`/`Mod-0`, `Alt-z`, `Mod-Shift-v` — reaches the surface directly,
 * with no reference to `PaneCommandState` or `buildCommands`'s `enabled` at all. CodeMirror's
 * `run` returning `true` sets `defaultPrevented` on the native event before `EditorApp`'s window
 * listener ever sees it (`commandForEvent` bails out on `e.defaultPrevented`), so while the
 * surface has focus these chords bypass the registry entirely and fire even when the matching
 * command is disabled — an assist run in flight, a pending proposal, a read-only pane. This is
 * why `onSave` (AssetPane.tsx) re-guards itself on `readOnly` / `busy` / `proposed !== null`
 * rather than trusting the button's `disabled` to be the only way in: Ctrl+S arrives here first,
 * not through the window keymap. `cycleViewMode` has the same exposure (finding 1 in the
 * whole-branch review) — it is NOT re-plumbed through the registry here, deliberately: this
 * keymap reads a pane-local ref precisely so the surface works with no host at all, and adding a
 * dependency on `PaneCommandState` would break that. If a future `enabled` term is ever added to
 * a command whose chord also lives here, re-check whether this file's own handler needs the same
 * term — the registry will not enforce it for you.
 */
export function editorKeymap(cmds: { current: SurfaceCommands }): Extension {
  return keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        cmds.current.save()
        return true
      }
    },
    // Both spellings: the physical key reports as `=` unshifted and `+` shifted, and Electron's
    // default zoom accelerators claim the same chord — returning true is what stops the whole
    // window scaling instead of the editor's font.
    ...['Mod-=', 'Mod-+'].map((key) => ({
      key,
      preventDefault: true,
      run: () => {
        cmds.current.changeFontSize(1)
        return true
      }
    })),
    {
      key: 'Mod--',
      preventDefault: true,
      run: () => {
        cmds.current.changeFontSize(-1)
        return true
      }
    },
    {
      key: 'Mod-0',
      preventDefault: true,
      run: () => {
        cmds.current.changeFontSize(0)
        return true
      }
    },
    {
      key: 'Alt-z',
      preventDefault: true,
      run: () => {
        cmds.current.toggleWrap()
        return true
      }
    },
    // Spec §5.7 names Ctrl+H, and `searchKeymap` does not bind it (verified against 6.7.1:
    // Mod-f, F3, Mod-g, Escape, Mod-Shift-l, Mod-Alt-g, Mod-d). The panel is the same one Mod-f
    // opens — it carries the replace row whenever the document is editable — so this is the
    // chord, not a second surface.
    {
      key: 'Mod-h',
      preventDefault: true,
      run: openSearchPanel
    },
    {
      key: 'Mod-Shift-v',
      preventDefault: true,
      run: () => {
        cmds.current.cycleViewMode()
        return true
      }
    },
    ...closeBracketsKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...completionKeymap,
    ...markdownKeymap,
    ...defaultKeymap
  ])
}
