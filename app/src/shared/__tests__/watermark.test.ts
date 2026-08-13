import { describe, it, expect } from 'vitest'
import { defaultSettings, DEFAULT_WATERMARK_TEXT } from '../settings'
import { applyWatermark } from '../watermark'

const MARK = '_AI-assisted — drafted by Argus, reviewed before posting._'
const on = { enabled: true, text: MARK }

describe('applyWatermark', () => {
  it('returns the body untouched when disabled', () => {
    expect(applyWatermark('body\n', { enabled: false, text: MARK })).toBe('body\n')
  })

  it('returns the body untouched when the text is empty or blank', () => {
    expect(applyWatermark('body\n', { enabled: true, text: '' })).toBe('body\n')
    expect(applyWatermark('body\n', { enabled: true, text: '   \n' })).toBe('body\n')
  })

  it('separates body and mark with exactly one blank line', () => {
    expect(applyWatermark('body', on)).toBe(`body\n\n${MARK}`)
    expect(applyWatermark('body\n', on)).toBe(`body\n\n${MARK}`)
    expect(applyWatermark('body\n\n\n  ', on)).toBe(`body\n\n${MARK}`)
  })

  it('is idempotent when the body already ends with the mark', () => {
    const once = applyWatermark('body', on)
    expect(applyWatermark(once, on)).toBe(once)
    expect(applyWatermark(`${once}\n\n`, on)).toBe(`${once}\n\n`)
  })

  it('does not treat a mark in the middle of the body as already applied', () => {
    const body = `${MARK}\n\nactual content`
    expect(applyWatermark(body, on)).toBe(`${body}\n\n${MARK}`)
  })

  it('trims surrounding whitespace off the configured text', () => {
    expect(applyWatermark('body', { enabled: true, text: `  ${MARK}  ` })).toBe(`body\n\n${MARK}`)
  })
})

describe('watermark settings defaults', () => {
  it('defaults Jira on and GitHub off, both with the shared default text', () => {
    const s = defaultSettings()
    expect(s.watermark.jira).toEqual({ enabled: true, text: DEFAULT_WATERMARK_TEXT })
    expect(s.watermark.github).toEqual({ enabled: false, text: DEFAULT_WATERMARK_TEXT })
  })

  it('fills in both targets when the section is absent (no migration needed)', () => {
    const parsed = defaultSettings()
    expect(parsed.watermark.jira.text).toBe(DEFAULT_WATERMARK_TEXT)
  })
})
