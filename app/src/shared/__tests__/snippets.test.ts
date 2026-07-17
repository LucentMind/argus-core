import { describe, it, expect } from 'vitest'
import { langForPath, SNIPPET_BEFORE, SNIPPET_AFTER } from '../snippets'

describe('langForPath', () => {
  it('maps code extensions to highlight.js language ids', () => {
    expect(langForPath('evidence/src/util.ts')).toEqual({ lang: 'typescript', kind: 'code' })
    expect(langForPath('evidence/Component.tsx')).toEqual({ lang: 'typescript', kind: 'code' })
    expect(langForPath('evidence/app.py')).toEqual({ lang: 'python', kind: 'code' })
    expect(langForPath('evidence/main.go')).toEqual({ lang: 'go', kind: 'code' })
    expect(langForPath('evidence/query.sql')).toEqual({ lang: 'sql', kind: 'code' })
    expect(langForPath('evidence/conf.yaml')).toEqual({ lang: 'yaml', kind: 'code' })
  })

  it('is case-insensitive on the extension', () => {
    expect(langForPath('evidence/QUERY.SQL').lang).toBe('sql')
  })

  it('treats logs, txt, derived extracts, and unknown extensions as plain text', () => {
    expect(langForPath('evidence/app.log')).toEqual({ lang: null, kind: 'text' })
    expect(langForPath('evidence/.derived/dump.txt')).toEqual({ lang: null, kind: 'text' })
    expect(langForPath('evidence/trace.dlt')).toEqual({ lang: null, kind: 'text' })
    expect(langForPath('evidence/README')).toEqual({ lang: null, kind: 'text' })
  })

  it('exports the snippet window constants', () => {
    expect(SNIPPET_BEFORE).toBe(4)
    expect(SNIPPET_AFTER).toBe(6)
  })
})
