import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The editor's chrome/sheet split (spec §6, editor treatment A): chrome is the frosted
 * `glass-chrome`, the sheets you actually read are the un-blurred `surface-card`. jsdom applies
 * no backdrop-filter, so the class assignment is the contract.
 *
 * `glass-chrome`, not `.glass-card`: `.glass-card` is unlayered CSS and carries `position:
 * relative` / `overflow: hidden` for the cursor-tracked ring/sheen layers a dashboard card hosts.
 * Applied directly to TabBar's root, that `overflow: hidden` clips the "All tabs" dropdown — the
 * exact class of bug `.overlay-card` / `.overlay-menu` (main.css) were already built to avoid for
 * ModalShell/MenuButton. `glass-chrome` (main.css, `@layer components`) shares `.overlay-card` /
 * `.overlay-menu`'s own light-mode recipe through the same `--glass-*` / `--card-shadow` tokens,
 * with none of the layout-carrying properties — same shape as `.overlay-card` / `.overlay-menu`.
 *
 * Task 10 review finding 7: the material-class assertions used to live here as bare file-string
 * scans (`expect(read('TabBar.tsx')).toContain('glass-chrome')`), which pass no matter WHERE in
 * the file the class sits and fail the moment anyone so much as writes the word in a comment.
 * They have moved to render-based assertions on the specific element's className, the way
 * `ModalShell.test.tsx` and `MenuButton.test.tsx` already check `.overlay-card`/`.overlay-menu`:
 *   - the tab strip's own root: `TabBar.test.tsx`
 *   - the status bar's own root: `StatusBar.test.tsx`
 *   - the editor shell (must carry `surface-card`, never `glass-panel`/`glass-card`/
 *     `glass-chrome`): `EditorApp.test.tsx`
 *
 * What's left here is genuinely a source scan: `bg-void`/`bg-deep` is a Tailwind utility literal
 * that jsdom cannot resolve into computed style either way, so a rendered assertion buys nothing
 * over reading the string; and the dark-alpha-fill sweep below would otherwise require mounting
 * every editor component in every state that can paint a fill, for a check that only cares which
 * class NAME appears in the source.
 */
const EDITOR = join(__dirname, '..')
const read = (f: string): string => readFileSync(join(EDITOR, f), 'utf8')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })
}

describe('editor window surfaces', () => {
  it('the editor root paints the ground, so the wash reaches it', () => {
    const app = read('EditorApp.tsx')
    expect(app).toContain('bg-void')
    expect(app).not.toContain('bg-deep')
  })

  // Task 10 review finding 6: this scan used to cover AssetPane.tsx alone and missed the
  // identical bug one file over, in DiffView.tsx's filler cell (`bg-black/10`). Widened to every
  // .tsx file under components/editor/ so the class of bug is covered, not one instance of it.
  it('no dark-only alpha fills survive anywhere in the editor window', () => {
    // bg-black/NN (and bg-white/NN) are dark-theme assumptions: invisible-to-wrong on a pale
    // ground.
    const files = walk(EDITOR)
    // A scan that silently covers zero files after a rename would pass forever.
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${file} uses a black/white alpha fill`).not.toMatch(/bg-(black|white)\//)
    }
  })
})
