import { describe, it, expect } from 'vitest'
import { commentsMarkdown } from '../../jiraCases'
import { JIRA_PROMPTS } from '../../jiraPrompts'
import { PANEL_DRAFTS } from '../../panels/draftMessages'
import { entryById } from '../registry'
import { fillPrompt } from '../fill'

const stub = (id: string): string => `<<${id}>>`

describe('jira comments banner', () => {
  it('is registered with the live text', () => {
    const e = entryById('generated-files.jira-comments-banner')
    expect(e?.default()).toBe(JIRA_PROMPTS['jira-comments-banner'].text)
    expect(e?.category).toBe('generated-files')
  })

  it('commentsMarkdown uses the resolved banner', () => {
    const out = commentsMarkdown('ABC-1', [], stub)
    expect(out).toContain('<<generated-files.jira-comments-banner>>')
    expect(out).toContain('# ABC-1: comments')
    expect(out).toContain('_(no comments)_')
  })

  it('commentsMarkdown with no resolver emits the default banner', () => {
    expect(commentsMarkdown('ABC-1', [])).toContain('> **Provenance notice:**')
  })
})

describe('panel-capture draft', () => {
  it('is registered as a synthesized entry with a relPath placeholder', () => {
    const e = entryById('synthesized.panel-capture')
    expect(e?.category).toBe('synthesized')
    expect(e?.placeholders).toEqual(['relPath'])
    expect(e?.default()).toBe(PANEL_DRAFTS['panel-capture'].text)
  })

  it('fills the saved path into the message', () => {
    expect(fillPrompt(PANEL_DRAFTS['panel-capture'].text, { relPath: 'evidence/p.png' })).toBe(
      'I captured this from a panel and saved it as evidence/p.png — use Read on that path to view the image.'
    )
  })
})
