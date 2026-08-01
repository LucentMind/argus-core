import { describe, it, expect, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { editorKeymap, type SurfaceCommands } from '../keymap'

const stub = (): { current: SurfaceCommands } => ({
  current: {
    save: vi.fn(),
    changeFontSize: vi.fn(),
    toggleWrap: vi.fn(),
    cycleViewMode: vi.fn(),
    openLink: vi.fn()
  }
})

/** The flattened binding list, in precedence order — earlier wins in CodeMirror. */
const bindings = (): { key?: string; run?: unknown }[] =>
  EditorState.create({ extensions: editorKeymap(stub()) })
    .facet(keymap)
    .flat()

describe('editorKeymap', () => {
  it('binds every chord the spec names', () => {
    const keys = bindings().map((b) => b.key)
    // Mod-h is the one that is NOT free from searchKeymap — see the comment on that binding.
    for (const key of ['Mod-s', 'Mod-=', 'Mod-+', 'Mod--', 'Mod-0', 'Alt-z', 'Mod-h']) {
      expect(keys).toContain(key)
    }
  })

  it('puts the custom bindings ahead of the stock keymaps', () => {
    const keys = bindings().map((b) => b.key)
    // defaultKeymap binds Mod-d/Mod-f-adjacent editing commands and is spread last precisely so
    // it cannot shadow the chords above. If this inverts, Mod-s silently stops saving.
    expect(keys.indexOf('Mod-s')).toBeLessThan(keys.lastIndexOf('Mod-d'))
    expect(keys.indexOf('Alt-z')).toBeLessThan(keys.lastIndexOf('Mod-d'))
  })

  it('does not bind Tab, which would trap keyboard users in the editor', () => {
    expect(bindings().map((b) => b.key)).not.toContain('Tab')
  })

  it('routes each custom chord to its command, read at press time', () => {
    const cmds = stub()
    const found = EditorState.create({ extensions: editorKeymap(cmds) })
      .facet(keymap)
      .flat()
    const run = (key: string): void => {
      const b = found.find((x) => x.key === key)
      expect(b, `no binding for ${key}`).toBeDefined()
      ;(b!.run as (v: unknown) => boolean)({ state: EditorState.create({ doc: '' }) })
    }
    run('Mod-s')
    expect(cmds.current.save).toHaveBeenCalled()
    run('Alt-z')
    expect(cmds.current.toggleWrap).toHaveBeenCalled()
    run('Mod-=')
    expect(cmds.current.changeFontSize).toHaveBeenCalledWith(1)
    run('Mod--')
    expect(cmds.current.changeFontSize).toHaveBeenCalledWith(-1)
    run('Mod-0')
    expect(cmds.current.changeFontSize).toHaveBeenCalledWith(0)
  })
})
