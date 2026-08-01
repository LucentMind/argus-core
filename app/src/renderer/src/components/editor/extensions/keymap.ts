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
