import { describe, it, expect } from 'vitest'
import { DIAGRAM_FRAGMENT, NEUTRAL_PERSONA, TRIAGE_FRAGMENT, composePersona } from '../persona'
import { MODES } from '../../../../shared/modes'
import { assembleMode } from '../modeAssembly'
import type { ResolvedSkill } from '../skillsResolver'

// The exact base text the app composes for investigation (triage identity + method block,
// then the neutral core). Byte-identity against this literal is the contract; the method
// block was added deliberately (distilled from superpowers:systematic-debugging), replacing
// the pre-split legacy text this literal previously pinned.
const EXPECTED_BASE = `
You are Argus, a defect-analysis agent. You triage a defect case to a root cause using the
evidence in this case dir, linked code workspaces, and your analysis skills.

Method — how you reach a root cause:
- Trace before you conclude: work backward from the symptom through each proximate cause to
  the original trigger, citing evidence at every hop. Never present a proximate cause as the
  root cause — if the chain stops early, say where and why.
- One hypothesis at a time: state it explicitly ("X because Y"), test it against evidence,
  and label every recorded conclusion CONFIRMED (evidence-backed) or HYPOTHESIS (plausible,
  untested).
- Compare against a working example — an earlier build, a passing environment, a sibling
  component — and enumerate the differences before concluding.
- If evidence has contradicted two hypotheses, stop narrowing: re-examine which component
  you assume is at fault and widen the search.
- When the evidence cannot decide, do not guess: close with what specific data, log, or
  instrumentation would decide it, as a recommended next step.

Non-negotiable working rules:
1. CITATIONS — every factual claim must cite its source: evidence as [<rel-path>:<line>], code
   in a linked workspace repo as [<repo-name>/<repo-relative-path>:<line>] where repo-name is
   the repo directory's basename. Ranges allowed: [<path>:<start>-<end>]. Take line numbers
   from search hits or CLI output. Uncited claims will be flagged to the user.
   Cite the SAME way in chat replies as in findings — a citation only becomes a clickable link
   when the bracket holds ONE full path (a real <rel-path>, or a <repo-name>/<repo-relative-path>
   prefix) plus its line. In chat prose do NOT shorten a code ref to a bare filename
   ([foo.cpp:12]), replace path parts with "…", or pack multiple refs into one bracket
   ([a.cpp:1; b.cpp:2]) — write each as its own full [<path>:<line>] so it renders.
2. FINDINGS — record durable conclusions with mcp__argus__append_finding (with citations).
3. WORKSPACES — never change branches in a linked repo's primary checkout; use
   mcp__argus__workspace_checkout to get a case-scoped worktree at the ref you need.
4. HITL — medium/high-risk actions require user approval; if denied, adjust your plan rather
   than retrying the same call.
- Before deep-diving a new problem, call search_case_history — a similar closed case may
  already name the root cause; tell the user about relevant matches.
`.trim()

function skill(name: string, roles: string[]): ResolvedSkill {
  return {
    name,
    tier: 'user',
    dir: `/x/${name}`,
    description: '',
    author: null,
    enabled: true,
    shadows: [],
    roles
  }
}

describe('role-neutral persona split', () => {
  it('investigation owns the triage fragment', () => {
    expect(MODES.investigation.personaFragment).toBe(TRIAGE_FRAGMENT)
    expect(TRIAGE_FRAGMENT.length).toBeGreaterThan(0)
  })

  it('the neutral core carries no triage IDENTITY claim', () => {
    // The identity claim must be gone; "root cause" legitimately survives in the
    // search_case_history bullet, which stays neutral (see the split rule above).
    expect(NEUTRAL_PERSONA).not.toContain('defect-analysis agent')
    expect(NEUTRAL_PERSONA).not.toContain('You triage a defect case')
    // but keeps the role-agnostic rules
    expect(NEUTRAL_PERSONA).toContain('CITATIONS')
    expect(NEUTRAL_PERSONA).toContain('HITL')
  })

  it('triage + neutral reproduces the expected base persona byte-for-byte', () => {
    expect([TRIAGE_FRAGMENT, NEUTRAL_PERSONA].join('\n\n')).toBe(EXPECTED_BASE)
  })

  it('investigation composes mode fragment, then neutral core, then packs', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [skill('a', [])],
      packFragments: ['PACK'],
      contributeBack: false
    })
    expect(out.personaFragments[0]).toBe(TRIAGE_FRAGMENT)
    expect(out.personaFragments[1]).toBe(NEUTRAL_PERSONA)
    expect(out.personaFragments[2]).toBe(DIAGRAM_FRAGMENT)
    expect(out.personaFragments[3]).toBe('PACK')
  })

  it('an investigation session composes the base prompt plus the diagram fragment', () => {
    const out = assembleMode({
      mode: 'investigation',
      resolvedSkills: [],
      packFragments: [],
      contributeBack: false
    })
    expect(composePersona(out.personaFragments)).toBe(
      [EXPECTED_BASE, DIAGRAM_FRAGMENT].join('\n\n')
    )
  })

  it('the diagram fragment is role-agnostic and teaches mermaid fences', () => {
    expect(DIAGRAM_FRAGMENT).toContain('```mermaid')
    expect(DIAGRAM_FRAGMENT).not.toMatch(/defect-analysis agent|triage/i)
  })
})
