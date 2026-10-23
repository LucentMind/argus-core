import { describe, it, expect } from 'vitest'
import { alignAnchor } from '../anchorAlign'
import { buildHistoryDigest } from '../historyDigest'
import type { AgentEvent } from '../../../../shared/agent-events'

const pt = (text: string, anchor: string | null): { text: string; anchor: string | null } => ({
  text,
  anchor
})
/** A real digest, built by the real builder, so the suffix rule is tested against what
 *  session.ts actually sends and not against a hand-written imitation of it. */
const digest = buildHistoryDigest([
  { turnId: 1, type: 'turn.started', payload: { userText: 'earlier question' } },
  { turnId: 1, type: 'assistant.message', payload: { text: 'earlier answer ok' } }
] as unknown as AgentEvent[])

describe('alignAnchor', () => {
  it('maps a 1:1 session turn-for-turn', () => {
    const provider = [pt('one', 'a1'), pt('two', 'a2'), pt('three', 'a3')]
    const prompts = ['one', 'two', 'three']
    expect([0, 1, 2].map((i) => alignAnchor(prompts, i, provider))).toEqual(['a1', 'a2', 'a3'])
  })

  it('gives a turn with no provider turn (a local /command) the previous anchor', () => {
    const provider = [pt('one', 'a1'), pt('two', 'a2')]
    const prompts = ['one', '/context', 'two']
    expect(alignAnchor(prompts, 1, provider)).toBe('a1')
    expect(alignAnchor(prompts, 2, provider)).toBe('a2')
  })

  it('matches the turn that carried a history digest', () => {
    expect(digest.length).toBeGreaterThan(0)
    const provider = [pt(digest + 'who are you', 'a1'), pt('next', 'a2')]
    expect(alignAnchor(['who are you', 'next'], 0, provider)).toBe('a1')
  })

  it('does not accept a bare suffix: "ok" is not a prompt that merely ends in ok', () => {
    const provider = [pt('it is ok', 'a1')]
    expect(alignAnchor(['ok'], 0, provider)).toBeNull()
  })

  it('does not accept a digest-carrying prompt that merely ENDS with this one', () => {
    // Ends in "ok" and carries a digest — but the prompt after the record is "is it ok".
    const provider = [pt(digest + 'is it ok', 'a1')]
    expect(alignAnchor(['ok'], 0, provider)).toBeNull()
    expect(alignAnchor(['is it ok'], 0, provider)).toBe('a1')
  })

  it('refuses when a provider turn is left unaccounted for', () => {
    // An expanded slash command: Argus sent "/skill x", the provider recorded something else.
    const provider = [
      pt('one', 'a1'),
      pt('<command-name>/skill</command-name>', 'a2'),
      pt('three', 'a3')
    ]
    const prompts = ['one', '/skill x', 'three']
    expect(alignAnchor(prompts, 0, provider)).toBeNull()
    expect(alignAnchor(prompts, 2, provider)).toBeNull()
  })

  it('refuses when the provider has turns Argus does not (a trailing leftover)', () => {
    expect(alignAnchor(['one'], 0, [pt('one', 'a1'), pt('two', 'a2')])).toBeNull()
  })

  it('refuses a failed attempt and its identical retry — the owner of the reply is ambiguous', () => {
    const provider = [pt('same', 'a1')]
    expect(alignAnchor(['same', 'same'], 0, provider)).toBeNull()
    expect(alignAnchor(['same', 'same'], 1, provider)).toBeNull()
  })

  it('accepts two identical prompts when the provider recorded both', () => {
    const provider = [pt('same', 'a1'), pt('same', 'a2')]
    expect(alignAnchor(['same', 'same'], 0, provider)).toBe('a1')
    expect(alignAnchor(['same', 'same'], 1, provider)).toBe('a2')
  })

  it('refuses an anchor turn with nothing matched at or before it', () => {
    const provider = [pt('two', 'a2')]
    expect(alignAnchor(['/context', 'two'], 0, provider)).toBeNull()
    expect(alignAnchor(['/context', 'two'], 1, provider)).toBe('a2')
  })

  it('refuses a matched turn the provider recorded no reply for', () => {
    expect(alignAnchor(['one'], 0, [pt('one', null)])).toBeNull()
    // …rather than slicing at the previous turn's reply: the provider DID record this prompt,
    // so cutting before it would drop a message the conversation actually contains.
    expect(alignAnchor(['one', 'two'], 1, [pt('one', 'a1'), pt('two', null)])).toBeNull()
  })

  it('refuses when the transcript is gone, and on an out-of-range anchor', () => {
    expect(alignAnchor(['one'], 0, [])).toBeNull()
    expect(alignAnchor(['one'], 1, [pt('one', 'a1')])).toBeNull()
    expect(alignAnchor(['one'], -1, [pt('one', 'a1')])).toBeNull()
  })

  it('tolerates CRLF and surrounding whitespace, nothing else', () => {
    const provider = [pt('line one\r\nline two  ', 'a1')]
    expect(alignAnchor(['  line one\nline two'], 0, provider)).toBe('a1')
    expect(alignAnchor(['line one line two'], 0, provider)).toBeNull()
  })
})
