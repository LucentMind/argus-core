import type { ViewMode } from './editorPrefs'

/**
 * Spec §6.4. One registry, read by the palette, the toolbar buttons and the window keymap, so a
 * shortcut and a button cannot drift apart — and one `enabled` per command in place of the
 * `disabled={busy || !loaded || proposed !== null}` conditions that used to be copied at each
 * call site.
 *
 * This module is **pure** and has no React import, which is the whole design. The rule it is
 * built around: this repo forbids reading a ref's `.current` during render. So the two halves of
 * a command travel in opposite directions —
 *
 *   state  UP as data ......... `PaneCommandState`, decides `enabled`, safe to read in render
 *   action DOWN through a ref .. `AssetPaneHandle`, called from `run()`, i.e. in a handler
 *
 * Collapsing either into the other breaks a lint rule this repo does not allow suppressing.
 */
export type CommandSection = 'File' | 'Go' | 'View' | 'Assist'

/**
 * What the ACTIVE pane reports upward. Deliberately small and all-primitive: it is recomputed on
 * every keystroke, and anything derived (an object, an array) would make the memo that feeds it
 * change identity every render.
 */
export interface PaneCommandState {
  mode: 'edit' | 'create'
  readOnly: boolean
  /** An assist run is in flight. */
  busy: boolean
  /** A proposal diff is on screen, awaiting Accept or Discard. */
  proposing: boolean
  /** Validation has at least one error, so a save would be refused. */
  blocked: boolean
  /** A draft file is believed to exist for this asset right now. */
  hasDraft: boolean
  /** Create mode with a non-empty Describe prompt and a working provider. */
  canDraft: boolean
  /** A non-empty document and a working provider. */
  canImprove: boolean
  viewMode: ViewMode
  wrap: boolean
}

/** Everything a command may do TO a pane. Held by `EditorApp` in a ref map, never read in render. */
export interface AssetPaneHandle {
  save(): void
  improve(): void
  draft(): void
  discardDraft(): void
  cycleViewMode(): void
  /** `+1` / `-1` steps; `0` resets to the default. */
  changeFontSize(delta: number): void
  toggleWrap(): void
  openGotoLine(): void
  findReferences(): void
  focus(): void
}

/** Everything a command may do to the WINDOW, supplied by `EditorApp`. */
export interface WindowCommands {
  quickOpen(): void
  commandPalette(): void
  closeTab(): void
  nextTab(): void
  prevTab(): void
}

export interface CommandContext {
  /** The active pane's reported state; `null` when no tab is open or it is still resolving. */
  pane: PaneCommandState | null
  /** Called at press time only. May legitimately return null between a tab opening and its
   *  `AssetTab` finishing its disk/draft resolve. */
  activePane: () => AssetPaneHandle | null
  /** Handles for the tabs the window believes are dirty. Save all writes only these — calling
   *  `save()` on a clean pane would rewrite the file and move its hash for nothing. */
  dirtyPanes: () => AssetPaneHandle[]
  dirtyCount: number
  tabCount: number
  window: WindowCommands
}

export interface Command {
  id: string
  title: string
  section: CommandSection
  /** Display form, e.g. `Ctrl+S`. Also what {@link commandForEvent} matches against — one
   *  string, so the palette cannot advertise a chord the keymap does not honour. */
  keybinding?: string
  enabled: boolean
  run: () => void
}

/** The fields of a `KeyboardEvent` this module reads. Narrowed so the tests need no DOM. */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

interface Chord {
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** Lower-cased. */
  key: string
}

/**
 * Keys whose physical press reports differently depending on Shift. The `=`/`+` pair is the one
 * that matters: the unshifted key reports `=` and the shifted one `+`, and Electron's own zoom
 * accelerators claim both — swallowing both spellings is what stops the whole window scaling
 * instead of the editor's font. Shift is ignored for these.
 */
const KEY_ALIASES: Record<string, readonly string[]> = {
  '=': ['=', '+']
}

function parseChord(display: string): Chord {
  const parts = display.split('+')
  // Split on '+' leaves the '+' KEY itself as an empty final part ('Ctrl++' -> ['Ctrl','','']),
  // so the key is the last non-empty part, or '+' when they are all empty.
  const key = parts.filter((p) => p !== '').pop() ?? '+'
  const mods = parts.slice(0, parts.lastIndexOf(key)).map((p) => p.toLowerCase())
  return {
    ctrl: mods.includes('ctrl'),
    shift: mods.includes('shift'),
    alt: mods.includes('alt'),
    key: key.toLowerCase()
  }
}

function matchesChord(e: KeyLike, c: Chord): boolean {
  if ((e.ctrlKey || e.metaKey) !== c.ctrl) return false
  if (e.altKey !== c.alt) return false
  const aliases = KEY_ALIASES[c.key]
  if (aliases) return aliases.includes(e.key.toLowerCase())
  if (e.shiftKey !== c.shift) return false
  return e.key.toLowerCase() === c.key
}

/**
 * The command this keystroke means, **enabled or not**.
 *
 * A disabled match is still returned on purpose: the caller swallows the key either way. Letting
 * a disabled Ctrl+W fall through would hand it to Electron, which closes the window.
 */
export function commandForEvent(cmds: readonly Command[], e: KeyLike): Command | null {
  for (const cmd of cmds) {
    if (cmd.keybinding && matchesChord(e, parseChord(cmd.keybinding))) return cmd
  }
  return null
}

export function buildCommands(ctx: CommandContext): Command[] {
  const p = ctx.pane
  // Every pane-scoped command shares this: a pane exists, no assist run is in flight, and no
  // proposal is waiting on a decision. Named once so the seven callers below cannot drift.
  const idle = p !== null && !p.busy && !p.proposing
  const writable = idle && !p.readOnly
  const on = (f: (h: AssetPaneHandle) => void) => (): void => {
    const h = ctx.activePane()
    if (h) f(h)
  }

  return [
    {
      id: 'save',
      title: 'Save',
      section: 'File',
      keybinding: 'Ctrl+S',
      enabled: writable && !p.blocked,
      run: on((h) => h.save())
    },
    {
      id: 'saveAll',
      title: 'Save all',
      section: 'File',
      keybinding: 'Ctrl+Alt+S',
      enabled: ctx.dirtyCount > 0,
      run: () => {
        for (const h of ctx.dirtyPanes()) h.save()
      }
    },
    {
      id: 'discardDraft',
      title: 'Discard draft',
      section: 'File',
      enabled: writable && p.hasDraft,
      run: on((h) => h.discardDraft())
    },
    {
      id: 'closeTab',
      title: 'Close tab',
      section: 'File',
      keybinding: 'Ctrl+W',
      enabled: ctx.tabCount > 0,
      run: () => ctx.window.closeTab()
    },
    {
      id: 'quickOpen',
      title: 'Open…',
      section: 'Go',
      keybinding: 'Ctrl+P',
      enabled: true,
      run: () => ctx.window.quickOpen()
    },
    {
      id: 'commandPalette',
      title: 'Show all commands',
      section: 'Go',
      keybinding: 'Ctrl+Shift+P',
      enabled: true,
      run: () => ctx.window.commandPalette()
    },
    {
      id: 'gotoLine',
      title: 'Go to line…',
      section: 'Go',
      // CodeMirror's own `searchKeymap` already binds this to `gotoLine` (verified against
      // @codemirror/search 6.7.1: Mod-f, F3, Mod-g, Escape, Mod-Shift-l, Mod-Alt-g, Mod-d).
      // Advertising the SAME chord rather than inventing a second one is the point of §6.4 —
      // and Ctrl+G is deliberately not used here, because that is findNext.
      keybinding: 'Ctrl+Alt+G',
      enabled: p !== null,
      run: on((h) => h.openGotoLine())
    },
    {
      id: 'findReferences',
      title: 'Find references to this file',
      section: 'Go',
      keybinding: 'Ctrl+Shift+F',
      // Create mode has no file for anything to cite yet, and the corpus lookup would miss.
      enabled: p !== null && p.mode === 'edit',
      run: on((h) => h.findReferences())
    },
    {
      id: 'nextTab',
      title: 'Next tab',
      section: 'Go',
      keybinding: 'Ctrl+Tab',
      enabled: ctx.tabCount > 1,
      run: () => ctx.window.nextTab()
    },
    {
      id: 'prevTab',
      title: 'Previous tab',
      section: 'Go',
      keybinding: 'Ctrl+Shift+Tab',
      enabled: ctx.tabCount > 1,
      run: () => ctx.window.prevTab()
    },
    {
      id: 'cycleViewMode',
      title: 'Cycle view mode',
      section: 'View',
      keybinding: 'Ctrl+Shift+V',
      // Not gated on readOnly: reading a protected asset in Preview is exactly what it is for.
      // Still gated on `proposing` — the diff replaces the editor, so cycling underneath it
      // would change a surface the user cannot see.
      enabled: idle,
      run: on((h) => h.cycleViewMode())
    },
    {
      id: 'toggleWrap',
      title: 'Toggle soft wrap',
      section: 'View',
      keybinding: 'Alt+Z',
      enabled: p !== null,
      run: on((h) => h.toggleWrap())
    },
    {
      id: 'fontIn',
      title: 'Increase font size',
      section: 'View',
      keybinding: 'Ctrl+=',
      enabled: p !== null,
      run: on((h) => h.changeFontSize(1))
    },
    {
      id: 'fontOut',
      title: 'Decrease font size',
      section: 'View',
      keybinding: 'Ctrl+-',
      enabled: p !== null,
      run: on((h) => h.changeFontSize(-1))
    },
    {
      id: 'fontReset',
      title: 'Reset font size',
      section: 'View',
      keybinding: 'Ctrl+0',
      enabled: p !== null,
      run: on((h) => h.changeFontSize(0))
    },
    {
      id: 'improve',
      title: 'Improve',
      section: 'Assist',
      enabled: writable && p.canImprove,
      run: on((h) => h.improve())
    },
    {
      id: 'draft',
      title: 'Draft',
      section: 'Assist',
      enabled: writable && p.mode === 'create' && p.canDraft,
      run: on((h) => h.draft())
    }
  ]
}
