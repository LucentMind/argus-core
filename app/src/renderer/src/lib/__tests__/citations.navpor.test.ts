import { describe, it, expect } from 'vitest'
import { linkifyCitations, splitCitations } from '../citations'

// Real citation shapes seen in the NAVPOR-9917 session (bracketed/space-laden
// derived-trace filenames, comma line-lists, repo-prefixed code paths).
const REPO = ['navigation-native']
const isCite = (s: string): boolean => linkifyCitations(s, REPO) !== s

describe('NAVPOR-9917 citation grammar', () => {
  it('linkifies an evidence path containing nested [..] and spaces', () => {
    const s =
      '[evidence/.derived/2026-07-15_13.00.31_[20210311-015]_PO 512 T SEU888FA66_Trigger-F0043.DemoTrace.zip.txt:10620]'
    expect(isCite(s)).toBe(true)
    const seg = splitCitations(s, REPO)
    expect(seg).toEqual([
      {
        type: 'cite',
        relPath:
          'evidence/.derived/2026-07-15_13.00.31_[20210311-015]_PO 512 T SEU888FA66_Trigger-F0043.DemoTrace.zip.txt',
        start: 10620,
        end: 10620
      }
    ])
  })

  it('linkifies a bracketed evidence path with a range', () => {
    const s =
      '[evidence/.derived/2026-07-15_13.00.31_[20210311-015]_PO 512 T SEU888FA66_Trigger-F0043.DemoTrace.zip.txt:11111-11112]'
    const seg = splitCitations(s, REPO)
    expect(seg).toEqual([
      {
        type: 'cite',
        relPath:
          'evidence/.derived/2026-07-15_13.00.31_[20210311-015]_PO 512 T SEU888FA66_Trigger-F0043.DemoTrace.zip.txt',
        start: 11111,
        end: 11112
      }
    ])
  })

  it('supports comma line-lists, spanning first→last line', () => {
    const s = '[navigation-native/src/foo/route_alternative_internal.hpp:43,56]'
    const seg = splitCitations(s, REPO)
    expect(seg).toEqual([
      { type: 'cite', relPath: 'navigation-native/src/foo/route_alternative_internal.hpp', start: 43, end: 56 }
    ])
  })

  it('supports mixed range + comma line-lists', () => {
    const s =
      '[evidence/.derived/2026-07-15_13.00.31_[20210311-015]_x.txt:11123-11124,11139]'
    const seg = splitCitations(s, REPO)
    expect(seg[0]).toMatchObject({ type: 'cite', start: 11123, end: 11139 })
  })

  it('preserves the original line-spec text in the rendered label', () => {
    const out = linkifyCitations('[navigation-native/src/foo/x.hpp:43,56]', REPO)
    expect(out).toContain('[navigation-native/src/foo/x.hpp:43,56](cite://')
  })

  it('still linkifies a fully-qualified repo code citation', () => {
    expect(isCite('[navigation-native/src/navsdk/navigation/navigator_status_util.cpp:268-273]')).toBe(true)
  })

  // --- guards: prose brackets must NOT become citations, and must NOT swallow
  //     a real citation that follows them ---

  it('does not linkify prose log brackets without a :line ending', () => {
    expect(isCite('[nav-sdk]: [Coordinator] set routes')).toBe(false)
    expect(isCite("[IgnoredRoute(...#0), reason='fork point passed']")).toBe(false)
    expect(isCite('[maps-android\\Mbgl-LayerUtils]: Layer type: null unknown.')).toBe(false)
    expect(isCite('[23959:23959:1210121]')).toBe(false)
  })

  it('does not let a preceding prose bracket swallow a real citation', () => {
    const seg = splitCitations('log [#1] then [evidence/a.log:5] done', REPO)
    expect(seg).toEqual([
      { type: 'text', text: 'log [#1] then ' },
      { type: 'cite', relPath: 'evidence/a.log', start: 5, end: 5 },
      { type: 'text', text: ' done' }
    ])
  })

  it('linkifies a citation embedded right after a bracketed log fragment', () => {
    const s =
      "reason='fork point passed']` then [evidence/.derived/x_[20210311-015]_y.txt:11111-11112]"
    const seg = splitCitations(s, REPO)
    const cites = seg.filter((x) => x.type === 'cite')
    expect(cites).toHaveLength(1)
    expect(cites[0]).toMatchObject({ start: 11111, end: 11112 })
  })
})
