import { describe, it, expect } from 'vitest'
import { settingsSchema } from '../../../shared/settings'
import { DEFAULT_RCA_TEMPLATE } from '../../../shared/rcaTemplate'

describe('rca template defaults', () => {
  it('materializes the default template on a settings file that has no rca key', () => {
    const s = settingsSchema.parse({})
    expect(s.rca.template).toEqual(DEFAULT_RCA_TEMPLATE)
  })

  it('materializes the default template on an existing rca block that predates it', () => {
    const s = settingsSchema.parse({ rca: { techDestination: 'confluence-page', confluenceSpaceKey: 'ENG' } })
    expect(s.rca.techDestination).toBe('confluence-page')
    expect(s.rca.confluenceSpaceKey).toBe('ENG')
    expect(s.rca.template.exec.map((x) => x.id)).toEqual([
      'exec-what-happened',
      'exec-impact',
      'exec-root-cause',
      'exec-what-we-did',
      'exec-next-steps'
    ])
  })

  it('ships tech sections bound to claim slots, and a narrative impact section', () => {
    const tech = DEFAULT_RCA_TEMPLATE.tech
    expect(tech.map((x) => x.id)).toEqual([
      'tech-root-cause',
      'tech-impact',
      'tech-contributing',
      'tech-symptoms',
      'tech-ruled-out',
      'tech-remediation',
      'tech-narrative'
    ])
    expect(tech.find((x) => x.id === 'tech-impact')?.kind).toBe('narrative')
    expect(tech.find((x) => x.id === 'tech-symptoms')?.slot).toBe('symptoms')
    expect(tech.every((x) => x.enabled)).toBe(true)
  })

  it('gives every default section a globally unique id across BOTH reports', () => {
    // Increment 2 has the model return one flat `sections: Record<sectionId, …>` map, and the
    // renderer resolves a body from the id alone with no report argument. Ids that repeat across
    // exec and tech would collide in that map while needing different text.
    const ids = [...DEFAULT_RCA_TEMPLATE.exec, ...DEFAULT_RCA_TEMPLATE.tech].map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every exec section a model instruction and every claims section a slot', () => {
    for (const s of [...DEFAULT_RCA_TEMPLATE.exec, ...DEFAULT_RCA_TEMPLATE.tech]) {
      if (s.kind === 'narrative') expect(s.instruction?.length).toBeGreaterThan(0)
      else expect(s.slot).toBeTruthy()
    }
  })

  it('rejects a claims section with no slot', () => {
    const bad = { rca: { template: { exec: [], tech: [{ id: 'x', heading: 'X', kind: 'claims', enabled: true }] } } }
    expect(() => settingsSchema.parse(bad)).toThrow()
  })

  it('rejects a claims section in the exec list, naming the offending section', () => {
    // The exec report goes to a non-technical audience as a Jira comment and may never show
    // citations, finding ids, or file paths. `renderExecReport` is narrative-only by contract,
    // so a claims row moved into the exec list must be refused here rather than rendered wrong.
    const bad = {
      rca: {
        template: {
          exec: [
            { id: 'exec-root-cause', heading: 'Root cause', kind: 'claims', slot: 'root-cause', enabled: true }
          ],
          tech: []
        }
      }
    }
    expect(() => settingsSchema.parse(bad)).toThrow(/exec-root-cause/)
  })

  it('still accepts claims sections in the tech list', () => {
    const ok = {
      rca: {
        template: {
          exec: [],
          tech: [
            { id: 'tech-root-cause', heading: 'Root cause', kind: 'claims', slot: 'root-cause', enabled: true }
          ]
        }
      }
    }
    expect(settingsSchema.parse(ok).rca.template.tech[0].kind).toBe('claims')
  })

  it('rejects a narrative section with no instruction', () => {
    const bad = {
      rca: {
        template: {
          exec: [{ id: 'x', heading: 'X', kind: 'narrative', enabled: true }],
          tech: []
        }
      }
    }
    expect(() => settingsSchema.parse(bad)).toThrow()
  })

  it('rejects a narrative section with a whitespace-only instruction', () => {
    const bad = {
      rca: {
        template: {
          exec: [{ id: 'x', heading: 'X', kind: 'narrative', instruction: '   ', enabled: true }],
          tech: []
        }
      }
    }
    expect(() => settingsSchema.parse(bad)).toThrow()
  })

  it('the default template default is a fresh deep copy, not the shared DEFAULT_RCA_TEMPLATE object', () => {
    const s1 = settingsSchema.parse({})
    const s2 = settingsSchema.parse({})

    expect(s1.rca.template).not.toBe(DEFAULT_RCA_TEMPLATE)
    expect(s1.rca.template).not.toBe(s2.rca.template)
    expect(s1.rca.template.exec).not.toBe(DEFAULT_RCA_TEMPLATE.exec)
    expect(s1.rca.template.exec[0]).not.toBe(DEFAULT_RCA_TEMPLATE.exec[0])

    // mutate one parse result's template in place — a second parse (and the module-level
    // default) must be unaffected. toEqual would not catch aliasing; only this does.
    s1.rca.template.exec[0].heading = 'MUTATED'
    expect(s2.rca.template.exec[0].heading).not.toBe('MUTATED')
    expect(DEFAULT_RCA_TEMPLATE.exec[0].heading).not.toBe('MUTATED')
  })
})
