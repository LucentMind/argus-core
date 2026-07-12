import { describe, it, expect } from 'vitest'
import { distillTarget, buildDistillPrompt, type DistillInput } from '../refSync/distill'
import type { CreateQueryFn } from '../agent/session'

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

function fake(
  messages: unknown[],
  calls: Array<{ prompt: unknown; options: Record<string, unknown> }>
): CreateQueryFn {
  return ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args)
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        for (const m of messages) yield m
      },
      interrupt: async () => undefined
    }
  }) as never
}

describe('distillTarget', () => {
  it('runs a tool-less single-turn session and returns the last assistant text', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = []
    const out = await distillTarget(
      input,
      { model: 'claude-opus-4-8' },
      fake(
        [
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: '# Routing\n\nnew body\n' }] }
          },
          { type: 'result', subtype: 'success' }
        ],
        calls
      )
    )
    expect(out).toBe('# Routing\n\nnew body\n')
    expect(calls[0].options).toMatchObject({
      maxTurns: 1,
      allowedTools: [],
      model: 'claude-opus-4-8'
    })
    const first = await (
      calls[0].prompt as AsyncGenerator<{ message: { content: Array<{ text: string }> } }>
    ).next()
    const promptText = first.value.message.content[0].text
    expect(promptText).toContain('Target file: routing-flow.md')
    expect(promptText).toContain('tune `costing`')
    expect(promptText).toContain('DISTILL, do not transcribe')
  })

  it('throws on a failed result and on empty output (per-file isolation upstream)', async () => {
    await expect(
      distillTarget(input, {}, fake([{ type: 'result', subtype: 'error_max_turns' }], []))
    ).rejects.toThrow(/distill session failed/)
    await expect(
      distillTarget(input, {}, fake([{ type: 'result', subtype: 'success' }], []))
    ).rejects.toThrow(/no text/)
  })

  it('prompt embeds the confluence-pages.md contract rules', () => {
    const p = buildDistillPrompt({ ...input, currentBody: null })
    expect(p).toContain('(file does not exist yet)')
    expect(p).toContain('Dangling links')
    expect(p).toContain('SIGNAL PATTERNS VERBATIM')
    expect(p).toContain('postmortems')
  })
})
