import { describe, it, expect, beforeEach } from 'vitest'
import { stageCorrection } from '../correctFinding'
import { composerDraft } from '../composerDraft'
import { panelsStore, CHAT_TAB, FINDINGS_TAB } from '../panelsStore'

beforeEach(() => {
  composerDraft.clear('c1', 3)
  panelsStore.setCase('c1')
})

describe('stageCorrection', () => {
  it('stages the finding prefix for the session and switches to Chat', () => {
    panelsStore.setActiveTab(FINDINGS_TAB)
    stageCorrection('c1', 3, 7)
    expect(composerDraft.get('c1', 3)).toBe('Finding #7: ')
    expect(panelsStore.get().activeTab).toBe(CHAT_TAB)
  })
})
