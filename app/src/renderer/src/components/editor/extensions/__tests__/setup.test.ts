import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { baseExtensions, fontSizeCompartment, fontSizeTheme, wrapCompartment } from '../setup'

/** No DOM anywhere in this file. Assembling the extension list is state-level work, so it is
 *  provable headlessly — unlike anything that needs the view to measure (spec §8.2). */
const create = (opts = { fontSize: 13, wrap: true }): EditorState =>
  EditorState.create({ doc: 'hello\nworld', extensions: baseExtensions(opts) })

describe('baseExtensions', () => {
  it('assembles into a valid state', () => {
    expect(create().doc.toString()).toBe('hello\nworld')
  })

  it('turns line wrapping on when asked', () => {
    expect(create({ fontSize: 13, wrap: true }).facet(EditorView.contentAttributes)).toContainEqual(
      { class: 'cm-lineWrapping' }
    )
  })

  it('leaves line wrapping off when asked', () => {
    expect(
      create({ fontSize: 13, wrap: false }).facet(EditorView.contentAttributes)
    ).not.toContainEqual({ class: 'cm-lineWrapping' })
  })

  it('toggles wrap through the compartment without rebuilding the state', () => {
    // The property that matters: reconfiguring keeps the same document (and, in a real view, the
    // same undo history and cursor). A rebuild would not.
    const state = create({ fontSize: 13, wrap: false })
    const next = state.update({
      effects: wrapCompartment.reconfigure(EditorView.lineWrapping)
    }).state
    expect(next.facet(EditorView.contentAttributes)).toContainEqual({ class: 'cm-lineWrapping' })
    expect(next.doc.toString()).toBe('hello\nworld')
  })

  it('reconfigures the font size through its compartment', () => {
    const state = create()
    const twenty = fontSizeTheme(20)
    const next = state.update({ effects: fontSizeCompartment.reconfigure(twenty) }).state
    // `get()` is the assertion that actually discriminates. `reconfigure` on a compartment that
    // is not in the extension tree is a silent no-op — so asserting only that the document
    // survived would pass just as well with the compartment deleted and a fixed font size baked
    // into `argusTheme()`, which is precisely the regression this test exists to catch.
    // `get()` returns `undefined` in that case.
    expect(fontSizeCompartment.get(next)).toBe(twenty)
    expect(next.doc.toString()).toBe('hello\nworld')
  })
})
