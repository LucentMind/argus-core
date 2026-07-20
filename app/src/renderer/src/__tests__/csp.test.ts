import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The renderer's Content-Security-Policy is enforced by the real browser but NOT by
 * jsdom, so no component test can catch a scheme the policy forbids — a chip can render
 * `<img src="blob:…">` green across the whole suite and still show a broken image in the
 * running app. That happened: `img-src` listed only `'self' data:`, and the attachment
 * thumbnail (the renderer's first and only consumer of `URL.createObjectURL`) was blocked.
 *
 * These tests guard the coupling instead of the rendering: if renderer source mints object
 * URLs for display, the policy has to permit `blob:`.
 */

const HTML = path.resolve(__dirname, '../../index.html')
const RENDERER_SRC = path.resolve(__dirname, '..')

function cspDirectives(): Map<string, string[]> {
  const html = fs.readFileSync(HTML, 'utf8')
  const match = html.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/)
  if (!match) throw new Error(`No Content-Security-Policy meta tag found in ${HTML}`)
  const directives = new Map<string, string[]>()
  for (const part of match[1].split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name, sources)
  }
  return directives
}

/** Every .ts/.tsx under the renderer src tree, excluding test files. */
function rendererSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') rendererSourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

describe('renderer Content-Security-Policy', () => {
  it('permits blob: images, which the attachment thumbnail depends on', () => {
    expect(cspDirectives().get('img-src')).toContain('blob:')
  })

  it('still permits the sources the app already relied on', () => {
    const imgSrc = cspDirectives().get('img-src')
    expect(imgSrc).toContain("'self'")
    expect(imgSrc).toContain('data:')
  })

  it('keeps script-src locked down to self', () => {
    // Widening img-src must not become licence to widen the directives that matter more.
    expect(cspDirectives().get('script-src')).toEqual(["'self'"])
    expect(cspDirectives().get('default-src')).toEqual(["'self'"])
  })

  it('permits blob: whenever renderer source mints object URLs for display', () => {
    // The real coupling. If a future change introduces createObjectURL anywhere in the
    // renderer, this fails loudly unless the policy allows blob: — rather than shipping
    // an image that is broken only outside jsdom.
    const minters = rendererSourceFiles(RENDERER_SRC).filter((f) =>
      fs.readFileSync(f, 'utf8').includes('createObjectURL')
    )
    if (minters.length === 0) return // nothing depends on blob: yet
    expect(
      cspDirectives().get('img-src'),
      `object URLs are created in:\n${minters.join('\n')}`
    ).toContain('blob:')
  })
})
