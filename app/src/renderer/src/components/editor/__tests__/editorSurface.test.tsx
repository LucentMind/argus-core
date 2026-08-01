import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The editor's chrome/sheet split (spec §6, editor treatment A): chrome is the frosted
 * `glass-chrome`, the sheets you actually read are the un-blurred `glass-panel`. jsdom applies no
 * backdrop-filter, so the class assignment is the contract.
 *
 * `glass-chrome`, not `.glass-card`: `.glass-card` is unlayered CSS and carries `position:
 * relative` / `overflow: hidden` for the cursor-tracked ring/sheen layers a dashboard card hosts.
 * Applied directly to TabBar's root, that `overflow: hidden` clips the "All tabs" dropdown — the
 * exact class of bug `.overlay-card` / `.overlay-menu` (main.css) were already built to avoid for
 * ModalShell/MenuButton. `glass-chrome` (main.css, `@layer components`) reuses `.glass-card`'s own
 * light-mode recipe through the same `--glass-*` / `--card-shadow` tokens, with none of the
 * layout-carrying properties — same shape as `.overlay-card` / `.overlay-menu`.
 */
const EDITOR = join(__dirname, '..')
const read = (f: string): string => readFileSync(join(EDITOR, f), 'utf8')

describe('editor window surfaces', () => {
  it('the tab strip and status bar are frosted chrome', () => {
    expect(read('TabBar.tsx')).toContain('glass-chrome')
    expect(read('StatusBar.tsx')).toContain('glass-chrome')
  })

  it('the writing sheet is NOT blurred', () => {
    // The pane that holds the editor and preview must never be glass-card (or glass-chrome):
    // long-form text on a blurred translucent layer over a gradient has contrast that drifts
    // down the page.
    const app = read('EditorApp.tsx')
    expect(app).toContain('glass-panel')
    expect(app).not.toContain('glass-card')
    expect(app).not.toContain('glass-chrome')
  })

  it('the editor root paints the ground, so the wash reaches it', () => {
    const app = read('EditorApp.tsx')
    expect(app).toContain('bg-void')
    expect(app).not.toContain('bg-deep')
  })

  it('no dark-only alpha fills survive in the asset pane', () => {
    // bg-black/20 is invisible-to-wrong on a pale ground.
    expect(read('AssetPane.tsx')).not.toMatch(/bg-black\//)
  })
})
