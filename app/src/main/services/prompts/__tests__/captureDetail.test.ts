import { describe, it, expect } from 'vitest'
import { buildCaptureDetail } from '../captureDetail'
import type { SessionPromptCapture } from '../../../../shared/promptsIpc'

function capture(over: Partial<SessionPromptCapture> = {}): SessionPromptCapture {
  return {
    caseSlug: 'c-1',
    sessionId: 1,
    createdAt: '2026-07-27T10:00:00.000Z',
    driverKind: 'claude-agent-sdk',
    model: null,
    mode: 'investigation',
    permissionMode: 'default',
    transport: 'systemPrompt.append',
    systemAppend: 'PERSONA\n\n## Agent memory\nindex line',
    fragments: [],
    skillIndex: '',
    memoryIndex: 'index line',
    enabledSkills: [],
    tools: [],
    activeOverrides: [],
    ...over
  }
}

describe('buildCaptureDetail', () => {
  it('reports a match when the captured prompt still starts with the current persona', () => {
    const d = buildCaptureDetail({ capture: capture(), persona: () => 'PERSONA' })
    expect(d.personaMatchesCurrent).toBe(true)
    expect(d.capture.sessionId).toBe(1)
    // The persona itself is not shipped — only whether it matches. See promptsIpc.ts.
    expect(d).not.toHaveProperty('currentPersona')
  })

  it('reports a mismatch when the persona has changed since the session started', () => {
    const d = buildCaptureDetail({ capture: capture(), persona: () => 'PERSONA (overridden)' })
    expect(d.personaMatchesCurrent).toBe(false)
  })

  it('never claims a match when the current persona cannot be built', () => {
    // An unknown mode (a mode removed from MODES since the capture) must read as "cannot
    // compare", not as "unchanged" — a false green here would hide a real drift.
    const d = buildCaptureDetail({
      capture: capture({ mode: 'retired-mode' }),
      persona: () => {
        throw new Error('unknown mode: retired-mode')
      }
    })
    expect(d.personaMatchesCurrent).toBe(false)
  })

  it('never claims a match on an empty persona', () => {
    // Every string starts with '', so a bare startsWith would report a spurious match.
    const d = buildCaptureDetail({ capture: capture(), persona: () => '' })
    expect(d.personaMatchesCurrent).toBe(false)
  })
})
