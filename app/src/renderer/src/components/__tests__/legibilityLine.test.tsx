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
      // material on that outer <section>, never on the rows. The sanctioned exception is that
      // one <section> opening tag; everything else in the file — including the pending-evidence
      // rows and the "No evidence yet." row outside renderRow — stays guarded by the blunt
      // whole-file scan below. (Narrowing to just the renderRow body previously left those other
      // rows unguarded — review finding, case-chrome-symmetry Task 2.)
      if (file.endsWith('CaseFiles.tsx')) {
        const open = src.indexOf('<section')
        expect(open, 'CaseFiles.tsx: card <section> not found').toBeGreaterThan(-1)
        const close = src.indexOf('>', open)
        expect(close, 'CaseFiles.tsx: card <section> opening tag not closed').toBeGreaterThan(-1)
        src = src.slice(0, open) + src.slice(close)
        // Guard against silently degrading to an empty or near-whole-file scan (e.g. if
        // `<section` disappeared or the excised span grew unbounded): the scanned source must
        // still be substantial and still contain a known dense-row marker outside renderRow.
        // `pending-evidence` (not `first:border-t-0`): that class also appears inside
        // renderRow itself, so it stays in the excised span and can't detect the span growing
        // forward to swallow the rest of the file — the exact failure this guard exists to
        // catch. `pending-evidence` (the pending-evidence-<name> testid) sits after the
        // excised `<section` opening tag and nowhere inside it, so it is unique to the region
        // still at risk.
        expect(src.length).toBeGreaterThan(1000)
        expect(src, 'CaseFiles.tsx: expected row marker missing from scan').toContain(
          'pending-evidence'
        )
      }
      expect(src, `${file} puts material on a dense row`).not.toContain('glass-panel')
      expect(src, `${file} puts material on a dense row`).not.toContain('glass-card')
    }
  })
})
