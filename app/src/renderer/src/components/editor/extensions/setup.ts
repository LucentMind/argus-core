import { Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { history } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { highlightSelectionMatches } from '@codemirror/search'
import { lintGutter } from '@codemirror/lint'
import { assetLanguage } from './language'
import { argusHighlight, argusTheme } from './theme'

/** Reconfigured on Ctrl+± (spec §5.7) rather than rebuilt: rebuilding the view would throw away
 *  the undo history this increment exists to protect. */
export const fontSizeCompartment = new Compartment()

/** Reconfigured on Alt+Z. Same reasoning. */
export const wrapCompartment = new Compartment()

export function fontSizeTheme(px: number): Extension {
  return EditorView.theme({ '&': { fontSize: `${px}px` } })
}

/**
 * Spec §5.7's defaults: soft wrap and line numbers on, current-line highlight on.
 *
 * No `keymap` here — Task 6 owns that, because half the bindings need callbacks that only the
 * component can supply. No `linter()` source either: diagnostics are pushed synchronously with
 * `setDiagnostics` from `CodeSurface` (see Task 4), which avoids the lint source's ~750ms
 * debounce racing the validation this app already computes on every keystroke.
 */
export function baseExtensions(opts: { fontSize: number; wrap: boolean }): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    lintGutter(),
    assetLanguage(),
    argusHighlight(),
    argusTheme(),
    fontSizeCompartment.of(fontSizeTheme(opts.fontSize)),
    wrapCompartment.of(opts.wrap ? EditorView.lineWrapping : [])
  ]
}
