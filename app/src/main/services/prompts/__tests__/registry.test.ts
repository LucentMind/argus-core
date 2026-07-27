import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PROMPT_ENTRIES, entryById, type PromptEntry } from '../registry'
import { NATIVE_TOOL_SPECS } from '../../agent/nativeTools'
import { NEUTRAL_PERSONA, DIAGRAM_FRAGMENT, CONTRIBUTE_BACK_NUDGE } from '../../agent/persona'
import { MODES } from '../../../../shared/modes'
import { SKILL_INDEX_LEAD } from '../../agent/skillIndex'
import { MEMORY_HEADER } from '../../agent/session'
import { CASE_WORKING_RULES } from '../../caseService'
import { CASE_DISTILL_CONTRACT } from '../../distill/caseDistillContract'
import { DISTILL_CONTRACT } from '../../refSync/distill'

// Repo root from app/src/main/services/prompts/__tests__ → up 6.
const REPO_ROOT = path.resolve(__dirname, '../../../../../..')

describe('prompt registry', () => {
  it('has unique ids', () => {
    const ids = PROMPT_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every category is represented', () => {
    const cats = new Set(PROMPT_ENTRIES.map((e) => e.category))
    for (const c of [
      'persona',
      'session-context',
      'tools',
      'headless',
      'generated-files',
      'external'
    ])
      expect(cats.has(c as PromptEntry['category'])).toBe(true)
  })

  it('non-external entries have text and no note; external entries are the inverse', () => {
    for (const e of PROMPT_ENTRIES) {
      if (e.category === 'external') {
        expect(e.default(), e.id).toBe('')
        expect(e.note?.length ?? 0, e.id).toBeGreaterThan(0)
        expect(e.editable, e.id).toBe(false)
      } else {
        expect(e.default().length, e.id).toBeGreaterThan(0)
        expect(e.note, e.id).toBeUndefined()
      }
    }
  })

  it('every source names a file that exists', () => {
    // Line numbers are deliberately NOT asserted — they drift on unrelated edits above them,
    // and a test that fails for that reason trains people to ignore it. A moved or deleted
    // module is the failure that matters.
    for (const e of PROMPT_ENTRIES) {
      const file = e.source.split(':')[0]
      expect(fs.existsSync(path.join(REPO_ROOT, file)), `${e.id} → ${file}`).toBe(true)
    }
  })

  it('defaults are byte-identical to the constants they reference', () => {
    expect(entryById('persona.mode.investigation')?.default()).toBe(
      MODES.investigation.personaFragment
    )
    expect(entryById('persona.mode.review')?.default()).toBe(MODES.review.personaFragment)
    expect(entryById('persona.neutral')?.default()).toBe(NEUTRAL_PERSONA)
    expect(entryById('persona.diagram')?.default()).toBe(DIAGRAM_FRAGMENT)
    expect(entryById('persona.contribute-back')?.default()).toBe(CONTRIBUTE_BACK_NUDGE)
    expect(entryById('session.skill-index-lead')?.default()).toBe(SKILL_INDEX_LEAD)
    expect(entryById('session.memory-header')?.default()).toBe(MEMORY_HEADER)
    expect(entryById('generated-files.case-working-rules')?.default()).toBe(CASE_WORKING_RULES)
    expect(entryById('headless.case-distill.contract')?.default()).toBe(CASE_DISTILL_CONTRACT)
    expect(entryById('headless.ref-distill.contract')?.default()).toBe(DISTILL_CONTRACT)
  })

  it('registers one entry per mode, so a new mode cannot crash session construction', () => {
    const modeEntries = PROMPT_ENTRIES.filter((e) => e.id.startsWith('persona.mode.'))
    expect(modeEntries.length).toBe(Object.keys(MODES).length)
    for (const id of Object.keys(MODES)) {
      const e = entryById(`persona.mode.${id}`)
      expect(e, id).toBeDefined()
      expect(e?.default()).toBe(MODES[id as keyof typeof MODES].personaFragment)
    }
  })

  it('registers exactly one entry per native tool, with the live description', () => {
    const toolEntries = PROMPT_ENTRIES.filter((e) => e.category === 'tools')
    expect(toolEntries.length).toBe(NATIVE_TOOL_SPECS.length)
    for (const s of NATIVE_TOOL_SPECS) {
      const e = entryById(`tool.${s.name}.description`)
      expect(e, s.name).toBeDefined()
      expect(e?.default()).toBe(s.description)
    }
  })

  it('native tool descriptions reach the two drivers that register them', () => {
    const e = entryById('tool.grep_lines.description')
    expect(e?.reaches).toEqual(['claude-agent-sdk', 'github-copilot'])
  })

  it('entryById returns undefined for an unknown id', () => {
    expect(entryById('nope.not.real')).toBeUndefined()
  })

  it('every declared placeholder appears in the entry default that declares it', () => {
    // Otherwise setOverride would reject an override for a token the default itself lacks —
    // an entry nobody could ever edit.
    for (const e of PROMPT_ENTRIES) {
      for (const p of e.placeholders ?? []) {
        expect(e.default(), `${e.id} is missing {${p}}`).toContain(`{${p}}`)
      }
    }
  })
})
