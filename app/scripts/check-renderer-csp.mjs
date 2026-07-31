#!/usr/bin/env node
/**
 * Assert every `data:` URI in the built renderer is permitted by that window's CSP.
 *
 * Why a build-output check and not a unit test: the failure this guards against is created by
 * the bundler, not by our source. Vite's `build.assetsInlineLimit` silently rewrites any
 * referenced asset under the threshold into a base64 `data:` URI. Our CSP is `default-src
 * 'self'` with `data:` widened for images ONLY, so an inlined font/media/etc. is blocked at
 * runtime — in the packaged build only, because `electron-vite dev` serves the same asset
 * same-origin over http and never inlines. Source, types, and the unit suite are all green
 * while the shipped app drops the asset. That is exactly how a JetBrains Mono subset shipped
 * blocked: at 2028 bytes it was the only font under the default 4096-byte threshold.
 *
 * Runs as the last step of `npm run build`, so it can hard-fail rather than skip: the artifact
 * is guaranteed to exist at that point. Exits 0 when every `data:` URI is allowed, 1 otherwise.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = path.join(appDir, 'out', 'renderer')

if (!existsSync(rendererDir)) {
  console.error(`check-renderer-csp: no build at ${rendererDir}. Run \`npm run build\` first.`)
  process.exit(1)
}

/** Every file the renderer can load a `data:` URI from. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.(js|mjs|cjs|css|html)$/.test(entry.name)) out.push(p)
  }
  return out
}

const files = walk(rendererDir)
const htmlFiles = files.filter((f) => f.endsWith('.html'))

if (htmlFiles.length === 0) {
  console.error('check-renderer-csp: no HTML entry found in the build; cannot read a CSP.')
  process.exit(1)
}

/** Parse `<meta http-equiv="Content-Security-Policy" content="...">` into directive -> sources. */
function parseCsp(html, file) {
  // The content attribute is full of `'self'`, so the delimiter must be back-referenced
  // rather than matched with a `[^"']` class that would stop at the first source keyword.
  const meta = html.match(
    /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content=(["'])([\s\S]*?)\1/i
  )
  if (!meta) {
    console.error(`check-renderer-csp: ${path.basename(file)} has no CSP meta tag.`)
    process.exit(1)
  }
  const directives = new Map()
  for (const part of meta[2].split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name.toLowerCase(), sources)
  }
  return directives
}

/**
 * Which directive governs a `data:` URI of this MIME type. CSP falls back to `default-src`
 * when the specific directive is absent, which is why an unset `font-src` inherits
 * `default-src 'self'` and blocks `data:`.
 */
function directiveFor(mime) {
  const type = mime.split('/')[0]
  if (type === 'font') return 'font-src'
  if (type === 'image') return 'img-src'
  if (type === 'audio' || type === 'video') return 'media-src'
  if (mime === 'text/html') return 'frame-src'
  return 'default-src'
}

function allowsData(directives, directive) {
  const sources = directives.get(directive) ?? directives.get('default-src') ?? []
  return sources.some((s) => s === 'data:' || s === '*')
}

/**
 * `data:` URIs that appear in the bundle but are never loaded, with the evidence for that.
 * A scan of built JS cannot tell a live asset from a dead string literal in a vendored library,
 * so each exemption is stated rather than silently dropped, and is scoped to the file that
 * carries it — the same MIME appearing anywhere else still fails.
 */
const ACCEPTED = [
  {
    mime: 'text/html',
    carrier: /^assets[\\/]mermaid\.core-/,
    reason:
      "mermaid's securityLevel:'sandbox' renderer, which wraps output in <iframe " +
      'src="data:text/html;base64,...">. Argus pins securityLevel:\'strict\' in ' +
      'src/renderer/src/lib/mermaid.ts (asserted in its test), so this branch never runs.'
  }
]

const acceptedFor = (mime, carriers) =>
  ACCEPTED.find((a) => a.mime === mime && carriers.every((c) => a.carrier.test(c)))

// Collect every distinct `data:<mime>` in the build, with the files that carry it.
const found = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)/g)) {
    const mime = m[1].toLowerCase()
    if (!found.has(mime)) found.set(mime, new Set())
    found.get(mime).add(path.relative(rendererDir, file))
  }
}

const violations = []
const exempted = []
for (const html of htmlFiles) {
  const directives = parseCsp(readFileSync(html, 'utf8'), html)
  for (const [mime, carriers] of found) {
    const directive = directiveFor(mime)
    if (!allowsData(directives, directive)) {
      const accepted = acceptedFor(mime, [...carriers])
      if (accepted) {
        exempted.push(`data:${mime} — ${accepted.reason}`)
        continue
      }
      violations.push({
        window: path.relative(rendererDir, html),
        mime,
        directive,
        blockedBy: directives.has(directive) ? directive : 'default-src (no ' + directive + ')',
        carriers: [...carriers]
      })
    }
  }
}

const summary = [...found.keys()].sort().join(', ') || '(none)'
console.log(`check-renderer-csp: ${found.size} data: URI type(s) across the build: ${summary}`)
for (const e of [...new Set(exempted)]) console.log(`  exempt: ${e}`)

if (violations.length > 0) {
  console.error('\ncheck-renderer-csp: FAIL — data: URIs the CSP will block at runtime:\n')
  for (const v of violations) {
    console.error(`  ${v.window}: data:${v.mime} blocked by ${v.blockedBy}`)
    for (const c of v.carriers) console.error(`      in ${c}`)
  }
  console.error(
    '\nFix the bundle, not the policy, unless the type genuinely needs a data: allowance:\n' +
      '  - fonts/media inlined by Vite -> lower `build.assetsInlineLimit` so they emit as files\n' +
      '  - only widen the CSP directive if the data: URI is built at runtime and cannot be a file\n'
  )
  process.exit(1)
}

console.log(`check-renderer-csp: OK — all permitted by the CSP in ${htmlFiles.length} window(s).`)
