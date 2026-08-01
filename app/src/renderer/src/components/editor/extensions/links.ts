import { Compartment, RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { resolveLink, scanLinks } from '../../../lib/mdLinks'

/**
 * Reconfigured when the known-reference set changes — which happens **after mount**, because it
 * comes from `refsync:get` / `refsync:changed`. Baking the set into the initial state would
 * decorate every link as broken for as long as the read took, and refuse every Ctrl+click in
 * that window. Same lesson as `readOnlyCompartment`; applied before it could bite.
 */
export const linkCompartment = new Compartment()

export interface LinkOptions {
  /** Every reference filename the editor could open. */
  targets: readonly string[]
  onOpen: (file: string) => void
}

/** Where the links are and whether each one resolves. Pure, and the whole of what the tests
 *  drive — the decoration layer below is a thin adaptor onto it. */
export function linkTargetsOf(
  doc: string,
  targets: readonly string[]
): { from: number; to: number; ok: boolean }[] {
  return scanLinks(doc).map((l) => ({
    from: l.from,
    to: l.to,
    ok: resolveLink(l.target, targets) !== null
  }))
}

const OK = Decoration.mark({ class: 'cm-argus-link' })
const BAD = Decoration.mark({ class: 'cm-argus-link-broken' })

function build(view: EditorView, targets: readonly string[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  // Visible ranges only: a long reference is thousands of lines and the scan runs on every
  // viewport change. `visibleRanges` is ascending and non-overlapping, and `scanLinks` returns
  // ascending matches, which is what `RangeSetBuilder` requires.
  for (const { from, to } of view.visibleRanges) {
    for (const r of linkTargetsOf(view.state.doc.sliceString(from, to), targets)) {
      b.add(from + r.from, from + r.to, r.ok ? OK : BAD)
    }
  }
  return b.finish()
}

/**
 * Spec §6.3, half one.
 *
 * Takes a **ref**, for the same reason `editorKeymap` does: `onOpen` closes over React state and
 * changes identity on every render, and rebuilding the extension on every keystroke would
 * discard the plugin's decoration cache on each one. Read at event time instead.
 */
export function linkExtension(ref: { current: LinkOptions }): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        constructor(view: EditorView) {
          this.decorations = build(view, ref.current.targets)
        }
        update(u: ViewUpdate): void {
          if (u.docChanged || u.viewportChanged) {
            this.decorations = build(u.view, ref.current.targets)
          }
        }
      },
      { decorations: (v) => v.decorations }
    ),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        // Ctrl/Cmd + primary button only. A plain click must still place the cursor inside the
        // link text, which is why this is not a bare click handler.
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
        if (pos === null) return false
        const line = view.state.doc.lineAt(pos)
        const hit = scanLinks(line.text).find(
          (l) => pos >= line.from + l.from && pos <= line.from + l.to
        )
        if (!hit) return false
        const file = resolveLink(hit.target, ref.current.targets)
        if (!file) return false
        // Swallowed so the modifier-click does not also start a rectangular selection.
        e.preventDefault()
        ref.current.onOpen(file)
        return true
      }
    }),
    // Raw CSS variables, not Tailwind: CodeMirror styles are injected as a StyleModule and
    // resolve against whatever `[data-theme]` is on `:root`, so this follows a theme change for
    // free (see argusTheme's note in theme.ts).
    EditorView.baseTheme({
      '.cm-argus-link': {
        color: 'var(--signal)',
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
        cursor: 'pointer'
      },
      '.cm-argus-link-broken': {
        textDecoration: 'underline wavy',
        textDecorationColor: 'var(--review)',
        textUnderlineOffset: '3px'
      }
    })
  ]
}
