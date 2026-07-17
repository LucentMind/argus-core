import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

/** Lazy highlight.js: core is tiny; each grammar loads as its own chunk on
 *  first use. Loader keys are the language ids produced by langForPath —
 *  static import strings so the bundler can code-split them. */
const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  python: () => import('highlight.js/lib/languages/python'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  sql: () => import('highlight.js/lib/languages/sql'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  json: () => import('highlight.js/lib/languages/json'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css')
}

const ready = new Set<string>()
const pending = new Map<string, Promise<boolean>>()

export function isRegistered(lang: string): boolean {
  return ready.has(lang)
}

export function ensureLanguage(lang: string): Promise<boolean> {
  if (ready.has(lang)) return Promise.resolve(true)
  const loader = LOADERS[lang]
  if (!loader) return Promise.resolve(false)
  let p = pending.get(lang)
  if (!p) {
    p = loader().then(
      (m) => {
        hljs.registerLanguage(lang, m.default)
        ready.add(lang)
        return true
      },
      () => false
    )
    pending.set(lang, p)
  }
  return p
}

/** Highlight one line; hljs escapes the input, so the result is safe HTML. */
export function highlightLine(code: string, lang: string): string {
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
}
