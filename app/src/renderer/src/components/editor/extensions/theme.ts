import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/**
 * Built from `assets/theme.css`'s raw variables rather than the Tailwind aliases: CodeMirror
 * styles are injected as a StyleModule, so they cannot use Tailwind classes, but `var(--ink)`
 * resolves against whatever `[data-theme]` is on `:root` right now. That means light theme, and
 * the cross-window theme change `uiStore` already broadcasts, both work with no subscription
 * here at all.
 *
 * `background: transparent` throughout: the surface sits inside the panel card Task 10 builds,
 * and a CodeMirror-owned background would paint over its rounded corners.
 */
export function argusTheme(): Extension {
  return EditorView.theme({
    '&': {
      color: 'var(--ink)',
      backgroundColor: 'transparent',
      height: '100%'
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
      lineHeight: '1.55',
      padding: '12px 0',
      caretColor: 'var(--signal)'
    },
    '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--faint)',
      border: 'none',
      borderRight: '1px solid var(--hair)',
      paddingRight: '4px'
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dim)' },
    '.cm-activeLine': { backgroundColor: 'var(--hair)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--signal)' },
    // The selection layer is a set of drawn elements, not a native ::selection, once
    // drawSelection() is in play — both are styled so a blurred window still shows the range.
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--signal) 26%, transparent)'
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--review) 22%, transparent)'
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--signal) 22%, transparent)',
      outline: 'none'
    },
    // The lint gutter's own markers, restyled off their stock red/orange dots.
    '.cm-lint-marker-error': { content: 'none', color: 'var(--danger)' },
    '.cm-lint-marker-warning': { content: 'none', color: 'var(--defect)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-over)',
      border: '1px solid var(--hair-2)',
      borderRadius: 'var(--radius-r2, 6px)',
      color: 'var(--ink)',
      fontSize: '12px'
    },
    // `--well`, not `--bg-hi` (Task 12): the CodeMirror surface sits inside the panel card (see
    // this file's own doc comment), and `--bg-hi` is tuned for the wash, not a near-white card.
    '.cm-panels': {
      backgroundColor: 'var(--well)',
      color: 'var(--ink)',
      borderTop: '1px solid var(--hair)'
    },
    // Ctrl+F's panel is stock markup; these three rules are what stop it looking pasted in.
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      backgroundColor: 'var(--bg-2)',
      color: 'var(--ink)',
      border: '1px solid var(--hair-2)',
      borderRadius: 'var(--radius-r1, 5px)',
      padding: '2px 6px',
      fontSize: '12px'
    },
    '.cm-panel.cm-search label': { color: 'var(--dim)', fontSize: '12px' },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--defect) 30%, transparent)'
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--defect) 55%, transparent)'
    }
  })
}

/**
 * Markdown and YAML highlighting, in the app's accent palette.
 *
 * Deliberately restrained: this is prose with a config header, not code. Structure (headings,
 * frontmatter keys, code, links) is distinguished; everything else stays `--ink`, so the file
 * reads as text rather than as a christmas tree.
 */
export function argusHighlight(): Extension {
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.heading1, t.heading2, t.heading3], color: 'var(--ink)', fontWeight: '600' },
      { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--dim)', fontWeight: '600' },
      { tag: t.processingInstruction, color: 'var(--faint)' },
      { tag: t.strong, fontWeight: '600' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
      { tag: [t.link, t.url], color: 'var(--signal)', textDecoration: 'underline' },
      { tag: [t.monospace, t.literal], color: 'var(--review)' },
      { tag: t.quote, color: 'var(--dim)', fontStyle: 'italic' },
      { tag: t.list, color: 'var(--dim)' },
      // The frontmatter block: keys are the thing validation talks about, so they get the accent.
      { tag: [t.definition(t.propertyName), t.propertyName, t.keyword], color: 'var(--signal)' },
      { tag: [t.string, t.attributeValue], color: 'var(--ink)' },
      { tag: t.number, color: 'var(--defect)' },
      { tag: t.comment, color: 'var(--faint)', fontStyle: 'italic' },
      { tag: t.invalid, color: 'var(--danger)' }
    ])
  )
}
