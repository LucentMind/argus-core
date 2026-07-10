import { describe, it, expect } from 'vitest'
import { adfToMarkdown } from '../adf'

const doc = (content: unknown[]): unknown => ({ type: 'doc', version: 1, content })

describe('adfToMarkdown', () => {
  it('passes through plain strings and empty descriptions', () => {
    expect(adfToMarkdown('already text')).toBe('already text')
    expect(adfToMarkdown(null)).toBe('')
    expect(adfToMarkdown(undefined)).toBe('')
  })

  it('renders paragraphs, marks, headings and links', () => {
    const md = adfToMarkdown(
      doc([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Repro' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'crash in ' },
            { type: 'text', text: 'NavSdk', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' see ' },
            {
              type: 'text',
              text: 'logs',
              marks: [{ type: 'link', attrs: { href: 'https://x.test/l' } }]
            }
          ]
        }
      ])
    )
    expect(md).toContain('## Repro')
    expect(md).toContain('**NavSdk**')
    expect(md).toContain('[logs](https://x.test/l)')
  })

  it('renders bullet/ordered lists and code blocks', () => {
    const md = adfToMarkdown(
      doc([
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }]
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }]
            }
          ]
        },
        { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x()' }] }
      ])
    )
    expect(md).toContain('- first')
    expect(md).toContain('- second')
    expect(md).toContain('```js\nx()\n```')
  })

  it('never throws on malformed content (non-array) — degrades to a string', () => {
    expect(() => adfToMarkdown(doc([{ type: 'paragraph', content: 'not-an-array' }]))).not.toThrow()
    expect(typeof adfToMarkdown(doc([{ type: 'paragraph', content: 'not-an-array' }]))).toBe(
      'string'
    )
  })

  it('degrades unknown nodes to their text content and never throws', () => {
    const md = adfToMarkdown(
      doc([
        {
          type: 'weirdFutureNode',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'still visible' }] }]
        },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'screenshot.png' } }] }
      ])
    )
    expect(md).toContain('still visible')
  })
})
