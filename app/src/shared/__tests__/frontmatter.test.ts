import { describe, it, expect } from 'vitest'
import { fmBlock, fmField, withFrontmatter } from '../frontmatter'

describe('frontmatter helpers', () => {
  it('parses CRLF and LF blocks', () => {
    const lf = fmBlock('---\ntrust_tier: hivemind\n---\nbody')
    expect(lf && fmField(lf.fm, 'trust_tier')).toBe('hivemind')
    const crlf = fmBlock('---\r\ntrust_tier: hivemind\r\n---\r\nbody')
    expect(crlf && fmField(crlf.fm, 'trust_tier')).toBe('hivemind')
    expect(crlf?.body).toBe('body')
    expect(fmBlock('no frontmatter')).toBeNull()
  })

  it('withFrontmatter overrides existing keys and creates a block when absent', () => {
    const stamped = withFrontmatter('---\ntrust_tier: confluence\ntitle: X\n---\nbody\n', {
      trust_tier: 'hivemind',
      source_commit: 'abc'
    })
    expect(stamped).toContain('trust_tier: hivemind')
    expect(stamped).not.toContain('trust_tier: confluence')
    expect(stamped).toContain('title: X')
    expect(stamped).toContain('source_commit: abc')
    expect(stamped.endsWith('body\n')).toBe(true)
    const created = withFrontmatter('plain body', { trust_tier: 'team-knowledge' })
    expect(created.startsWith('---\ntrust_tier: team-knowledge\n---\n')).toBe(true)
  })
})
