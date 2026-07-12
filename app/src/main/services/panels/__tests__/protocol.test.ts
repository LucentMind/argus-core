import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { resolvePanelAsset, buildPanelCsp, type PanelWindowLoc } from '../protocol'

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
    expect(resolvePanelAsset([win], 'argus-panel://sample-pack/text-viewer/../persona.md')).toBeNull()
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
})
