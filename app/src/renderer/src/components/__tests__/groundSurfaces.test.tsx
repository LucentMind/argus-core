import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `bg-deep` does two unrelated jobs in this codebase: it paints the page ground, and it paints
 * cards. The light-theme wash rule only covers `body` and `.bg-void`, so the two uses have to be
 * split at the call site — ground goes to `bg-void`, cards go to `surface-card`. This scans for
 * the split staying done, which no render test can do for files it never mounts.
 */
const COMPONENTS = join(__dirname, '..')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })
}

describe('ground surfaces', () => {
  // Scoped to the three files THIS task converts. The repo-wide scan lands in Task 8, once
  // every call site has actually been split — a guard that is knowingly red across three
  // tasks is a broken suite, not a checklist.
  const CONVERTED = ['TopBar.tsx', 'PanelTabStrip.tsx', 'SearchBar.tsx']

  it('the shell surfaces paint ground with bg-void, not bg-deep', () => {
    const files = walk(COMPONENTS).filter((f) => CONVERTED.some((c) => f.endsWith(c)))
    // A scan that silently covers zero files after a rename would pass forever.
    expect(files.length).toBe(CONVERTED.length)
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${file} still paints ground with bg-deep`).not.toContain('bg-deep')
      expect(src, `${file} still hand-rolls a card fill`).not.toMatch(/\bbg-panel\b/)
    }
  })
})
