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

  describe('card surfaces', () => {
    it('MermaidBlock thumbnail uses the shared material', () => {
      const [file] = walk(COMPONENTS).filter((f) => f.endsWith('MermaidBlock.tsx'))
      expect(file, 'MermaidBlock.tsx not found — rename?').toBeDefined()
      const src = readFileSync(file, 'utf8')
      // The thumbnail (the clickable preview) uses surface-card for the shared material.
      // The lightbox body is its own outermost dialog surface (a fixed-position backdrop),
      // so bg-panel is legitimate there — it's not a nested card inside another surface.
      expect(src).toContain('surface-card')
    })
  })
})

describe('the bg-deep split is complete', () => {
  // The brief for this scan (plan §Task 8 Step 6) assumed bg-deep had exactly six call sites
  // codebase-wide: ground in TopBar, PanelTabStrip, the editor root; cards in MetricCards, the
  // Observability select, MenuButton's dropdown — and that Tasks 5, 7 and 8 would leave all six
  // split, making a literal `walk(COMPONENTS)` repo-wide scan pass. Run empirically at Task 8
  // (after converting ui.tsx below), it instead turns up eleven files this plan never assigned to
  // anyone: CaseWorkspace.tsx, CitationCard.tsx, Composer.tsx, DeleteCaseDialog.tsx,
  // EditorApp.tsx, SetupWizard.tsx, TourCompanion.tsx, RepoGraphControl.tsx,
  // KnowledgeFlowStrip.tsx, SettingsView.tsx, ToolCallCard.tsx. Specifically:
  //   - EditorApp.tsx ("the editor root") is explicitly Task 10's job — see progress.md Task 5:
  //     "EditorApp.tsx:350 is the third such site; Task 10 will repeat it." Not done yet.
  //   - CaseWorkspace.tsx, Composer.tsx, CitationCard.tsx, ToolCallCard.tsx were explicitly
  //     verified-and-left-alone by Task 6 ("both paths are now correct, so they are not
  //     edited... Editing them would mean touching the `dynamic ? … : ''` ternaries, which is
  //     exactly where the layout-leak trap lives" — task-6-brief.md). ToolCallCard.tsx is also
  //     palette-only per the legibility line: it must never acquire a material, so its bg-deep
  //     is by design, not a miss.
  //   - SetupWizard.tsx, TourCompanion.tsx were explicitly excluded from Task 7's scope
  //     ("dialog/panel backgrounds, not main-window cards" — task-7-report.md).
  //   - DeleteCaseDialog.tsx (an <input> fill), RepoGraphControl.tsx, KnowledgeFlowStrip.tsx and
  //     SettingsView.tsx (a rail, mirroring CaseWorkspace's) were never named as a ground/card
  //     split target by any task in this 11-task plan.
  // A blanket assertion would force Task 8 ("Overlays") to rewrite ten files it was never asked
  // to touch — several reversing decisions already reviewed and approved in Tasks 6 and 7 — or
  // ship permanently red, which Task 5's own comment calls "a broken suite, not a checklist."
  // Scoped instead to the specific sites this task family actually promises to keep split; see
  // task-8-report.md for the full empirical trace and the reasoning above.
  const SPLIT_SITES = [
    'TopBar.tsx',
    'PanelTabStrip.tsx',
    'MetricCards.tsx',
    'ObservabilityView.tsx',
    'ui.tsx'
  ]

  it('no component this plan has actually converted paints ground or a card with bg-deep', () => {
    const files = walk(COMPONENTS).filter((f) => SPLIT_SITES.some((s) => f.endsWith(s)))
    // A scan that silently covers zero files after a rename would pass forever.
    expect(files.length).toBe(SPLIT_SITES.length)
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes('bg-deep'))
      .map((f) => f.split(/[\\/]/).pop()!)
    expect(offenders).toEqual([])
  })
})

describe('task 8b: the remaining bg-deep call sites are swept', () => {
  // The plan's Task 5/7/8 inventory claimed six bg-deep call sites; a repo-wide scan found
  // ~14. This task converts the rest: ground rails (CaseWorkspace, Composer, SettingsView),
  // cards (CitationCard, RepoGraphControl, KnowledgeFlowStrip, SetupWizard, TourCompanion), the
  // DeleteCaseDialog input (a control fill), and ToolCallCard's plain-fill token (bg-panel, no
  // material — it stays on the legibility line). EditorApp.tsx is explicitly excluded: Task 10
  // owns it.
  const CONVERTED_8B = [
    'CaseWorkspace.tsx',
    'Composer.tsx',
    'SettingsView.tsx',
    'CitationCard.tsx',
    'RepoGraphControl.tsx',
    'KnowledgeFlowStrip.tsx',
    'SetupWizard.tsx',
    'TourCompanion.tsx',
    'DeleteCaseDialog.tsx',
    'ToolCallCard.tsx'
  ]

  it('none of these still paint with bg-deep', () => {
    const files = walk(COMPONENTS).filter((f) => CONVERTED_8B.some((c) => f.endsWith(c)))
    // A scan that silently covers zero files after a rename would pass forever.
    expect(files.length).toBe(CONVERTED_8B.length)
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${file} still paints with bg-deep`).not.toContain('bg-deep')
    }
  })

  it('ToolCallCard stays palette-only — its bg-panel fill acquires no material class', () => {
    const [file] = walk(COMPONENTS).filter((f) => f.endsWith('ToolCallCard.tsx'))
    expect(file, 'ToolCallCard.tsx not found — rename?').toBeDefined()
    const src = readFileSync(file, 'utf8')
    expect(src, 'ToolCallCard.tsx must never acquire surface-card').not.toContain('surface-card')
    expect(src, 'ToolCallCard.tsx must never acquire glass-card').not.toContain('glass-card')
    expect(src, 'ToolCallCard.tsx must never acquire glass-panel').not.toContain('glass-panel')
  })
})

describe('viewers stay token-driven', () => {
  const VIEWERS = [
    'FileViewer.tsx',
    'TextViewer.tsx',
    'UnifiedDiffView.tsx',
    'HighlightedLines.tsx',
    'VirtualLines.tsx'
  ]

  it('no viewer hardcodes a colour or a black/white alpha fill', () => {
    const files = walk(COMPONENTS).filter((f) => VIEWERS.some((v) => f.endsWith(v)))
    // A scan that silently covers zero files after a rename would pass forever.
    expect(files.length).toBe(VIEWERS.length)
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${file} hardcodes a hex colour`).not.toMatch(/#[0-9a-fA-F]{6}\b/)
      expect(src, `${file} uses a black/white alpha fill`).not.toMatch(/bg-(black|white)\//)
    }
  })
})
