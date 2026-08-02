import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The legibility line (spec §3): material goes on structural objects, never on
 * dense text or on anything you type into. jsdom cannot see a computed
 * material, so the class list is the contract — and a source scan is the only
 * thing that catches a row acquiring it in a file this suite never renders.
 */
const SRC = join(__dirname, '..', '..')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })
}

describe('legibility line', () => {
  it('no material class on a form control primitive', () => {
    const layout = readFileSync(join(SRC, 'components/settings/settingsLayout.tsx'), 'utf8')
    // FIELD/TEXTAREA_FIELD are the shared control classes; Switch/SelectField use them
    const controls = layout.slice(
      layout.indexOf('export const FIELD'),
      layout.indexOf('DisclosureBtn')
    )
    expect(controls).not.toContain('glass-panel')
    expect(controls).not.toContain('glass-card')
  })

  it('no material class in the components that render dense rows', () => {
    const DENSE = ['CaseFiles.tsx', 'FindingCard.tsx', 'MessageView.tsx', 'ToolCallCard.tsx']
    const files = walk(join(SRC, 'components')).filter((f) => DENSE.some((d) => f.endsWith(d)))
    // A guard that silently scans zero files (e.g. after a rename) would pass forever —
    // fail loudly instead so the scan set staying non-empty is part of the contract.
    expect(files.length).toBe(DENSE.length)
    for (const file of files) {
      let src = readFileSync(file, 'utf8')
      // CaseFiles.tsx (Task 2, case-chrome-symmetry, 2026-08-02) wraps its dense evidence rows
      // in the same structural card idiom as the sibling rail sections (ReposSection etc.) —
      // material on that outer <section>, never on the rows. Unlike the other three DENSE files,
      // which are nothing but a single dense row/card, CaseFiles.tsx also contains that
      // legitimate structural wrapper, so the check is scoped to the row-rendering function
      // (`renderRow`) rather than the whole file.
      if (file.endsWith('CaseFiles.tsx')) {
        src = src.slice(src.indexOf('function renderRow'), src.indexOf('\n  return ('))
      }
      expect(src, `${file} puts material on a dense row`).not.toContain('glass-panel')
      expect(src, `${file} puts material on a dense row`).not.toContain('glass-card')
    }
  })
})
