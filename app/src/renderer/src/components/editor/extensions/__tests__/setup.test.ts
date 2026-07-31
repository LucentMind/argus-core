import { describe, it, expect } from 'vitest'
import { EditorState, type Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import {
  baseExtensions,
  fontSizeCompartment,
  fontSizeTheme,
  readOnlyCompartment,
  readOnlyExtension,
  wrapCompartment
} from '../setup'

/** No DOM anywhere in this file. Assembling the extension list is state-level work, so it is
 *  provable headlessly — unlike anything that needs the view to measure (spec §8.2). */
const create = (opts = { fontSize: 13, wrap: true, readOnly: false }): EditorState =>
  EditorState.create({ doc: 'hello\nworld', extensions: baseExtensions(opts) })

describe('baseExtensions', () => {
  it('assembles into a valid state', () => {
    expect(create().doc.toString()).toBe('hello\nworld')
  })

  it('turns line wrapping on when asked', () => {
    expect(
      create({ fontSize: 13, wrap: true, readOnly: false }).facet(EditorView.contentAttributes)
    ).toContainEqual({ class: 'cm-lineWrapping' })
  })

  it('leaves line wrapping off when asked', () => {
    expect(
      create({ fontSize: 13, wrap: false, readOnly: false }).facet(EditorView.contentAttributes)
    ).not.toContainEqual({ class: 'cm-lineWrapping' })
  })

  it('toggles wrap through the compartment without rebuilding the state', () => {
    // The property that matters: reconfiguring keeps the same document (and, in a real view, the
    // same undo history and cursor). A rebuild would not.
    const state = create({ fontSize: 13, wrap: false, readOnly: false })
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

/**
 * `readOnly` is derived from `skills:list` / `refsync:get`, both async, so a protected asset
 * routinely mounts EDITABLE (tier unresolved, predicate fails open) and only learns otherwise a
 * tick later. That is why it needs a compartment rather than being baked into the initial state,
 * and why the flip has to keep the buffer: the user may already have typed into it.
 */
describe('readOnly compartment', () => {
  it('starts editable when asked', () => {
    expect(create({ fontSize: 13, wrap: true, readOnly: false }).readOnly).toBe(false)
  })

  it('starts read-only when asked', () => {
    expect(create({ fontSize: 13, wrap: true, readOnly: true }).readOnly).toBe(true)
  })

  it('becomes read-only after mount, through the compartment', () => {
    const state = create({ fontSize: 13, wrap: true, readOnly: false })
    const locked = readOnlyExtension(true)
    const next = state.update({ effects: readOnlyCompartment.reconfigure(locked) }).state
    // `get()` discriminates: reconfiguring a compartment that is not in the extension tree is a
    // silent no-op, so asserting only `.readOnly` would also pass with the compartment deleted
    // and the extension baked in — the very shape this replaces.
    expect(readOnlyCompartment.get(next)).toBe(locked)
    expect(next.readOnly).toBe(true)
  })

  it('becomes editable again after mount, for a claimed reference', () => {
    const state = create({ fontSize: 13, wrap: true, readOnly: true })
    const next = state.update({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(false))
    }).state
    expect(next.readOnly).toBe(false)
  })

  it('keeps the document and its undo history across the flip', () => {
    // The whole reason this is a compartment and not a remount: the tier can arrive after the
    // user has typed, and a rebuilt view would throw that work — and its undo stack — away.
    const typed = create({ fontSize: 13, wrap: true, readOnly: false }).update({
      changes: { from: 11, insert: '!' }
    }).state
    expect(typed.doc.toString()).toBe('hello\nworld!')

    const locked = typed.update({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(true))
    }).state
    expect(locked.doc.toString()).toBe('hello\nworld!')
    // `undo` is itself gated on `state.readOnly`, which is the right behaviour and also a second
    // proof the reconfiguration actually took.
    expect(undo({ state: locked, dispatch: () => {} })).toBe(false)

    // Unlock again (the post-claim direction) and undo through the state-level command target, so
    // no view — and no DOM — is involved. A rebuilt state would have an empty history, so this is
    // what proves the two reconfigurations preserved it.
    const unlocked = locked.update({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(false))
    }).state
    const dispatched: Transaction[] = []
    const handled = undo({
      state: unlocked,
      dispatch: (tr) => {
        dispatched.push(tr)
      }
    })
    expect(handled).toBe(true)
    expect(dispatched[0].state.doc.toString()).toBe('hello\nworld')
  })
})
