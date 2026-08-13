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
      'what-happened',
      'impact',
      'root-cause',
      'what-we-did',
      'next-steps'
    ])
  })

  it('ships tech sections bound to claim slots, and a narrative impact section', () => {
    const tech = DEFAULT_RCA_TEMPLATE.tech
    expect(tech.map((x) => x.id)).toEqual([
      'root-cause',
      'impact',
      'contributing',
      'symptoms',
      'ruled-out',
      'remediation',
      'tech-narrative'
    ])
    expect(tech.find((x) => x.id === 'impact')?.kind).toBe('narrative')
    expect(tech.find((x) => x.id === 'symptoms')?.slot).toBe('symptoms')
    expect(tech.every((x) => x.enabled)).toBe(true)
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
})
