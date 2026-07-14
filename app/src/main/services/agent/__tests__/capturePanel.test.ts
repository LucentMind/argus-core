import { describe, it, expect } from 'vitest'
import { slugifyPanelTitle, compactStamp } from '../capturePanel'

describe('slugifyPanelTitle', () => {
  it('slugifies a normal title', () => {
    expect(slugifyPanelTitle('Nav Visualizer Map', 'win')).toBe('nav-visualizer-map')
  })
  it('collapses symbols and trims dashes', () => {
    expect(slugifyPanelTitle('  Logs (v2)!!  ', 'win')).toBe('logs-v2')
  })
  it('falls back to the windowId slug when the title is empty', () => {
    expect(slugifyPanelTitle('   ', 'Text_Viewer')).toBe('text-viewer')
  })
  it('falls back to "panel" when both are empty', () => {
    expect(slugifyPanelTitle('', '')).toBe('panel')
  })
})

describe('compactStamp', () => {
  it('strips punctuation and milliseconds', () => {
    expect(compactStamp(new Date('2026-07-14T15:30:12.123Z'))).toBe('20260714T153012Z')
  })
})
