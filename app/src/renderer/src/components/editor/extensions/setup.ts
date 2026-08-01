import { Compartment, EditorState, type Extension } from '@codemirror/state'
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
import { linkCompartment, linkExtension, type LinkOptions } from './links'

/** Reconfigured on Ctrl+± (spec §5.7) rather than rebuilt: rebuilding the view would throw away
 *  the undo history this increment exists to protect. */
export const fontSizeCompartment = new Compartment()

/** Reconfigured on Alt+Z. Same reasoning. */
export const wrapCompartment = new Compartment()

/**
 * Reconfigured when the asset's **tier resolves**, which happens after mount.
 *
 * `readOnly` is derived from `skills:list` / `refsync:get`, both async. A pane routinely mounts
 * before either lands, with the tier unknown and the predicate failing open — so the buffer
 * starts EDITABLE and only later learns it is protected. Baking `EditorState.readOnly.of(false)`
 * into the initial state left the banner up and Save disabled over a fully typable document.
 *
 * A compartment reconfigures without rebuilding the view, so the document, undo history and
 * cursor survive the flip — which is what makes this safe even when the tier arrives after the
 * user has typed. (Remounting under a new React `key` would throw that buffer away.)
 */
export const readOnlyCompartment = new Compartment()

export function fontSizeTheme(px: number): Extension {
  return EditorView.theme({ '&': { fontSize: `${px}px` } })
}

/** Both halves of "cannot be typed into": `readOnly` refuses document changes, `editable` also
 *  drops `contenteditable` so the caret and the OS IME stay out of it. */
export function readOnlyExtension(on: boolean): Extension {
  return on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
}

/**
 * Spec §5.7's defaults: soft wrap and line numbers on, current-line highlight on.
 *
 * No `keymap` here — Task 6 owns that, because half the bindings need callbacks that only the
 * component can supply. No `linter()` source either: diagnostics are pushed synchronously with
 * `setDiagnostics` from `CodeSurface` (see Task 4), which avoids the lint source's ~750ms
 * debounce racing the validation this app already computes on every keystroke.
 */
export function baseExtensions(opts: {
  fontSize: number
  wrap: boolean
  readOnly: boolean
  links: { current: LinkOptions }
}): Extension[] {
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
    wrapCompartment.of(opts.wrap ? EditorView.lineWrapping : []),
    readOnlyCompartment.of(readOnlyExtension(opts.readOnly)),
    linkCompartment.of(linkExtension(opts.links))
  ]
}
