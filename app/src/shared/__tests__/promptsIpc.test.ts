import { describe, it, expect } from 'vitest'
import { PROMPT_CATEGORY_LABELS, type PromptCategory } from '../promptsIpc'

describe('prompt IPC payload types', () => {
  it('labels every category exactly once', () => {
    const ids: PromptCategory[] = [
      'persona',
      'session-context',
      'tools',
      'tool-feedback',
      'headless',
      'generated-files',
      'synthesized',
      'external'
    ]
    for (const id of ids) expect(PROMPT_CATEGORY_LABELS[id], id).toBeTruthy()
    expect(Object.keys(PROMPT_CATEGORY_LABELS).sort()).toEqual([...ids].sort())
  })

  it('labels are human-facing prose, not the raw slug', () => {
    expect(PROMPT_CATEGORY_LABELS['session-context']).not.toBe('session-context')
    expect(PROMPT_CATEGORY_LABELS['generated-files']).not.toBe('generated-files')
  })
})
