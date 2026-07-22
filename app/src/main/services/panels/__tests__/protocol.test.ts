import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  resolvePanelAsset,
  buildPanelCsp,
  panelContentType,
  resolveCaseAsset,
  computeRange,
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

  it('adds the argus-case: scheme + media-src only when allowCaseFiles is set', () => {
    const withoutCase = buildPanelCsp([])
    expect(withoutCase).not.toContain('argus-case:')
    expect(withoutCase).not.toContain('media-src')

    const withCase = buildPanelCsp(['https://tiles.example.com'], { allowCaseFiles: true })
    expect(withCase).toContain("img-src 'self' data: argus-case: https://tiles.example.com")
    expect(withCase).toContain("media-src 'self' argus-case: https://tiles.example.com")
    expect(withCase).toContain("connect-src 'self' argus-case: https://tiles.example.com")
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
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/photo.png')).toBe(
      path.join(evidenceDir, 'photo.png')
    )
  })

  it('resolves a nested relPath', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/sub/clip.mp4')).toBe(
      path.join(evidenceDir, 'sub', 'clip.mp4')
    )
  })

  it('returns null for a missing caseSlug or relPath', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case:///photo.png')).toBeNull()
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/')).toBeNull()
  })

  it('rejects a parent-dir traversal', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/../../etc/passwd')).toBeNull()
  })

  it('rejects an absolute or backslash relpath', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A//etc/passwd')).toBeNull()
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/a\\b')).toBeNull()
  })

  it('returns null for a non-argus-case scheme or garbage', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'file:///etc/passwd')).toBeNull()
    expect(resolveCaseAsset(home, 'CASE-A', 'not a url')).toBeNull()
  })

  it('allows a filename that merely contains consecutive dots (not a traversal)', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/notes..final.pdf')).toBe(
      path.join(evidenceDir, 'notes..final.pdf')
    )
  })

  it('rejects a URL naming a DIFFERENT case than the bound one (cross-case isolation)', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-B/secret.pdf')).toBeNull()
  })

  it('allows a URL whose case matches the bound one case-insensitively', () => {
    // Chromium may canonicalize the standard-scheme host to lowercase; the path is still
    // built from the trusted bound slug's on-disk casing.
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://case-a/photo.png')).toBe(
      path.join(home, 'cases', 'CASE-A', 'evidence', 'photo.png')
    )
  })

  it('percent-decodes a filename with a space back to the real on-disk name', () => {
    // fetch()/WHATWG-URL encodes a space to %20 on the wire; Core must decode it so the
    // literal on-disk file "name with space.pbf.gz" is found (was a 404 before the decode).
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/name%20with%20space.pbf.gz')).toBe(
      path.join(evidenceDir, 'name with space.pbf.gz')
    )
  })

  it('percent-decodes # ? % in a nested filename', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/sub/rec%23a%3fb%25c.pbf')).toBe(
      path.join(evidenceDir, 'sub', 'rec#a?b%c.pbf')
    )
  })

  it('rejects percent-encoded traversal (%2e%2e%2f) after decoding', () => {
    // The raw-URL '..' guard does not catch encoded dots; the post-decode containment
    // check is load-bearing here.
    expect(
      resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/%2e%2e%2f%2e%2e%2fsecret')
    ).toBeNull()
  })

  it('rejects an encoded path separator (%2F) that would inject a segment', () => {
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/a%2f%2e%2e%2fsecret')).toBeNull()
  })

  it('returns null (not a throw) for a malformed percent sequence', () => {
    // decodeURIComponent throws on a stray '%'; a filename like "50%discount.txt" must
    // resolve to null, not crash the protocol handler.
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/50%discount.txt')).toBeNull()
    expect(resolveCaseAsset(home, 'CASE-A', 'argus-case://CASE-A/bad%zz.txt')).toBeNull()
  })
})

describe('computeRange', () => {
  it('serves the full body as 200 when there is no Range header', () => {
    expect(computeRange(null, 1000)).toEqual({
      status: 200,
      start: 0,
      end: 999,
      contentLength: 1000,
      contentRange: null
    })
  })

  it('serves a bounded range as 206 with Content-Range', () => {
    expect(computeRange('bytes=0-1023', 5000)).toEqual({
      status: 206,
      start: 0,
      end: 1023,
      contentLength: 1024,
      contentRange: 'bytes 0-1023/5000'
    })
  })

  it('clamps a range end past EOF to the last byte', () => {
    expect(computeRange('bytes=0-1023', 500)).toEqual({
      status: 206,
      start: 0,
      end: 499,
      contentLength: 500,
      contentRange: 'bytes 0-499/500'
    })
  })

  it('serves an open-ended range (bytes=start-) to EOF', () => {
    expect(computeRange('bytes=100-', 1000)).toEqual({
      status: 206,
      start: 100,
      end: 999,
      contentLength: 900,
      contentRange: 'bytes 100-999/1000'
    })
  })

  it('serves a suffix range (bytes=-N) as the last N bytes', () => {
    expect(computeRange('bytes=-500', 1000)).toEqual({
      status: 206,
      start: 500,
      end: 999,
      contentLength: 500,
      contentRange: 'bytes 500-999/1000'
    })
  })

  it('clamps a suffix range larger than the file to the whole file', () => {
    expect(computeRange('bytes=-2000', 1000)).toEqual({
      status: 206,
      start: 0,
      end: 999,
      contentLength: 1000,
      contentRange: 'bytes 0-999/1000'
    })
  })

  it('returns 416 when the range start is at or past EOF', () => {
    expect(computeRange('bytes=2000-3000', 1000)).toEqual({
      status: 416,
      start: 0,
      end: 0,
      contentLength: 0,
      contentRange: 'bytes */1000'
    })
  })

  it('ignores a malformed Range header and serves the full body as 200', () => {
    expect(computeRange('bytes=abc', 1000).status).toBe(200)
    expect(computeRange('items=0-10', 1000).status).toBe(200)
    expect(computeRange('gibberish', 1000).status).toBe(200)
  })

  it('ignores a multi-range request and serves the full body as 200', () => {
    // Serving multipart/byteranges is out of scope; a server may answer the full body.
    expect(computeRange('bytes=0-10,20-30', 1000).status).toBe(200)
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
