import { describe, it, expect } from 'vitest'
import { distillTarget, buildDistillPrompt, type DistillInput } from '../refSync/distill'

const input: DistillInput = {
  target: 'routing-flow.md',
  currentBody: '# Routing\n\nold\n',
  pages: [
    {
      title: 'Cache request tuning',
      url: 'https://x/104',
      markdown: 'tune `costing`',
      pageId: '104',
      version: 7
    }
  ]
}

describe('distillTarget', () => {
  it('passes the built prompt to the injected runner', async () => {
    let seen = ''
    const body = await distillTarget(
      { target: 'kafka.md', currentBody: null, pages: [] },
      async (prompt) => {
        seen = prompt
        return '# Kafka\n\nOverview.'
      }
    )
    expect(seen).toContain('# Target file: kafka.md')
    expect(body).toBe('# Kafka\n\nOverview.')
  })

  it('isolates a per-target failure: one target failing leaves the others intact', async () => {
    const run = async (prompt: string): Promise<string> => {
      if (prompt.includes('broken.md')) throw new Error('no provider configured for distillation')
      return '# Ok\n\nBody.'
    }
    await expect(
      distillTarget({ target: 'broken.md', currentBody: null, pages: [] }, run)
    ).rejects.toThrow('no provider configured')
    await expect(
      distillTarget({ target: 'fine.md', currentBody: null, pages: [] }, run)
    ).resolves.toContain('# Ok')
  })

  it('prompt embeds the confluence-pages.md contract rules', () => {
    const p = buildDistillPrompt({ ...input, currentBody: null })
    expect(p).toContain('(file does not exist yet)')
    expect(p).toContain('Dangling links')
    expect(p).toContain('SIGNAL PATTERNS VERBATIM')
    expect(p).toContain('postmortems')
  })
})
