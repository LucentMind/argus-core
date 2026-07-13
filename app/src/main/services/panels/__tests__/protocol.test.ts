import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  resolvePanelAsset,
  buildPanelCsp,
  panelContentType,
  resolveCaseAsset,
  type PanelWindowLoc
} from '../protocol'

const win: PanelWindowLoc = {
  packId: 'sample-pack',
  windowId: 'text-viewer',
  uiDir: path.join('/packs', 'sample-pack', 'ui'),
  entry: 'text-viewer/index.html'
}
const bundleRoot = path.join('/packs', 'sample-pack', 'ui', 'text-viewer')

describe('resolvePanelAsset', () => {
  it('resolves the entry html under the window bundle dir', () => {
    expect(resolvePanelAsset([win], 'argus-panel://sample-pack/text-viewer/index.html')).toBe(
      path.join(bundleRoot, 'index.html')
    )
  })

  it('resolves a nested sub-asset', () => {
    expect(resolvePanelAsset([win], 'argus-panel://sample-pack/text-viewer/assets/app.js')).toBe(
      path.join(bundleRoot, 'assets', 'app.js')
    )
  })

  it('returns null for an unknown pack/window', () => {
    expect(resolvePanelAsset([win], 'argus-panel://other/text-viewer/index.html')).toBeNull()
    expect(resolvePanelAsset([win], 'argus-panel://sample-pack/nope/index.html')).toBeNull()
  })

  it('rejects a parent-dir traversal', () => {
    expect(
      resolvePanelAsset([win], 'argus-panel://sample-pack/text-viewer/../persona.md')
    ).toBeNull()
  })

  it('rejects an absolute or backslash relpath', () => {
    expect(resolvePanelAsset([win], 'argus-panel://sample-pack/text-viewer//etc/passwd')).toBeNull()
    expect(resolvePanelAsset([win], 'argus-panel://sample-pack/text-viewer/a\\b')).toBeNull()
  })

  it('returns null for a non-argus-panel scheme or garbage', () => {
    expect(resolvePanelAsset([win], 'file:///etc/passwd')).toBeNull()
    expect(resolvePanelAsset([win], 'not a url')).toBeNull()
  })
})

describe('buildPanelCsp', () => {
  it('bundle-only when the allowlist is empty', () => {
    const csp = buildPanelCsp([])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).not.toContain('http')
  })

  it('folds declared origins into img-src and connect-src only', () => {
    const csp = buildPanelCsp(['https://tiles.example.com'])
    expect(csp).toContain("img-src 'self' data: https://tiles.example.com")
    expect(csp).toContain("connect-src 'self' https://tiles.example.com")
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toContain("script-src 'self' https")
  })

  it('rejects malformed origins with directive-injection chars (no scheme, contains semicolon and space)', () => {
    const csp = buildPanelCsp(["evil.com; font-src * 'unsafe-inline'"])
    expect(csp).toContain("font-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('evil.com')
  })

  it('accepts well-formed origins while rejecting malformed ones in the same allowlist', () => {
    const csp = buildPanelCsp(['https://ok.example.com', 'bad; x'])
    expect(csp).toContain("img-src 'self' data: https://ok.example.com")
    expect(csp).toContain("connect-src 'self' https://ok.example.com")
    expect(csp).not.toContain('bad')
  })
})

describe('panelContentType', () => {
  it('maps known extensions to their MIME type', () => {
    expect(panelContentType('index.html')).toBe('text/html; charset=utf-8')
    expect(panelContentType('app.js')).toBe('text/javascript; charset=utf-8')
    expect(panelContentType('logo.png')).toBe('image/png')
  })

  it('falls back to application/octet-stream for an unknown extension', () => {
    expect(panelContentType('x.bin')).toBe('application/octet-stream')
  })
})

describe('resolveCaseAsset', () => {
  const home = path.join('/argus-home')
  const evidenceDir = path.join(home, 'cases', 'CASE-A', 'evidence')

  it('resolves a file under the case evidence dir', () => {
    expect(resolveCaseAsset(home, 'argus-case://CASE-A/photo.png')).toBe(
      path.join(evidenceDir, 'photo.png')
    )
  })

  it('resolves a nested relPath', () => {
    expect(resolveCaseAsset(home, 'argus-case://CASE-A/sub/clip.mp4')).toBe(
      path.join(evidenceDir, 'sub', 'clip.mp4')
    )
  })

  it('returns null for a missing caseSlug or relPath', () => {
    expect(resolveCaseAsset(home, 'argus-case:///photo.png')).toBeNull()
    expect(resolveCaseAsset(home, 'argus-case://CASE-A/')).toBeNull()
  })

  it('rejects a parent-dir traversal', () => {
    expect(resolveCaseAsset(home, 'argus-case://CASE-A/../../etc/passwd')).toBeNull()
  })

  it('rejects an absolute or backslash relpath', () => {
    expect(resolveCaseAsset(home, 'argus-case://CASE-A//etc/passwd')).toBeNull()
    expect(resolveCaseAsset(home, 'argus-case://CASE-A/a\\b')).toBeNull()
  })

  it('returns null for a non-argus-case scheme or garbage', () => {
    expect(resolveCaseAsset(home, 'file:///etc/passwd')).toBeNull()
    expect(resolveCaseAsset(home, 'not a url')).toBeNull()
  })

  it('allows a filename that merely contains consecutive dots (not a traversal)', () => {
    expect(resolveCaseAsset(home, 'argus-case://CASE-A/notes..final.pdf')).toBe(
      path.join(evidenceDir, 'notes..final.pdf')
    )
  })
})

describe('panelContentType · case-file extensions', () => {
  it('maps common evidence file types', () => {
    expect(panelContentType('scan.pdf')).toBe('application/pdf')
    expect(panelContentType('call.mp3')).toBe('audio/mpeg')
    expect(panelContentType('clip.mp4')).toBe('video/mp4')
    expect(panelContentType('notes.md')).toBe('text/markdown; charset=utf-8')
    expect(panelContentType('log.txt')).toBe('text/plain; charset=utf-8')
  })
})
