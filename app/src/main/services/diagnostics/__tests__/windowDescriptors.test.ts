import { describe, it, expect } from 'vitest'
import { collectWindowDescriptors, type WindowSource } from '../windowDescriptors'

function src(over: Partial<WindowSource> & { id: number }): WindowSource {
  return { osPid: 100 + over.id, isBrowserWindow: false, panelTitle: null, isMain: false, ...over }
}

describe('collectWindowDescriptors', () => {
  it('classifies a panel before any window check', () => {
    // A FLOATED panel is its own BrowserWindow AND a panel. Panel must win, or a
    // popped-out panel would be labelled "Editor window".
    const out = collectWindowDescriptors([
      src({ id: 1, osPid: 11, panelTitle: 'Log viewer', isBrowserWindow: true })
    ])
    expect(out).toEqual([{ osPid: 11, kind: 'panel', title: 'Log viewer' }])
  })

  it('classifies the main window', () => {
    expect(collectWindowDescriptors([src({ id: 2, osPid: 12, isMain: true })])).toEqual([
      { osPid: 12, kind: 'main-window' }
    ])
  })

  it('classifies any other BrowserWindow as the editor window', () => {
    expect(collectWindowDescriptors([src({ id: 3, osPid: 13, isBrowserWindow: true })])).toEqual([
      { osPid: 13, kind: 'editor-window' }
    ])
  })

  it('keeps a panel with an empty title as a panel', () => {
    // panelTitle is '' not null — the check must be `!== null`, not truthiness.
    expect(collectWindowDescriptors([src({ id: 4, osPid: 14, panelTitle: '' })])).toEqual([
      { osPid: 14, kind: 'panel', title: '' }
    ])
  })

  it('skips a webContents with no resolvable os pid', () => {
    // getOSProcessId() returns 0 for a window that never loaded content — the panel
    // float-out host is exactly this case, and emitting osPid 0 would collide.
    expect(collectWindowDescriptors([src({ id: 5, osPid: 0, isBrowserWindow: true })])).toEqual([])
    expect(collectWindowDescriptors([src({ id: 6, osPid: null, isMain: true })])).toEqual([])
  })

  it('skips a webContents that is neither a panel nor a window', () => {
    expect(collectWindowDescriptors([src({ id: 7, osPid: 17 })])).toEqual([])
  })

  it('emits one descriptor per source when several share an os pid', () => {
    // Same-origin windows can share a renderer process; the label layer joins the
    // names, so BOTH descriptors must survive.
    const out = collectWindowDescriptors([
      src({ id: 8, osPid: 20, isMain: true }),
      src({ id: 9, osPid: 20, isBrowserWindow: true })
    ])
    expect(out).toEqual([
      { osPid: 20, kind: 'main-window' },
      { osPid: 20, kind: 'editor-window' }
    ])
  })
})
