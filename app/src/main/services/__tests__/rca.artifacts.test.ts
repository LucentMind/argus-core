import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readReportMarkdown, writeReportMarkdown, reportFile } from '../rca/artifacts'
import { artifactsDir } from '../paths'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-home-'))
})

function seed(slug: string, exec: string, tech: string): void {
  const dir = artifactsDir(home, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'rca-exec.md'), exec)
  fs.writeFileSync(path.join(dir, 'rca-tech.md'), tech)
}

describe('readReportMarkdown', () => {
  it('returns both reports', () => {
    seed('case-a', '# exec', '# tech')
    expect(readReportMarkdown(home, 'case-a')).toEqual({ exec: '# exec', tech: '# tech' })
  })

  it('returns null when the case has never been confirmed', () => {
    expect(readReportMarkdown(home, 'case-a')).toBeNull()
  })

  it('returns null when only one of the two files exists', () => {
    const dir = artifactsDir(home, 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'rca-exec.md'), '# exec')
    expect(readReportMarkdown(home, 'case-a')).toBeNull()
  })
})

describe('writeReportMarkdown', () => {
  it('overwrites one report without touching the other', () => {
    seed('case-a', '# exec', '# tech')
    writeReportMarkdown(home, 'case-a', 'exec', '# edited')
    expect(readReportMarkdown(home, 'case-a')).toEqual({ exec: '# edited', tech: '# tech' })
  })

  it('writes bytes verbatim, including trailing whitespace and CRLF', () => {
    seed('case-a', 'a', 'b')
    writeReportMarkdown(home, 'case-a', 'tech', 'line\r\n  trailing  ')
    expect(readReportMarkdown(home, 'case-a')!.tech).toBe('line\r\n  trailing  ')
  })

  it('refuses to write a case that has no artifacts directory', () => {
    expect(() => writeReportMarkdown(home, 'case-a', 'exec', 'x')).toThrow(/no confirmed/i)
  })
})

describe('reportFile', () => {
  it('resolves inside the case artifacts dir', () => {
    const f = reportFile(home, 'case-a', 'exec')
    expect(f.startsWith(artifactsDir(home, 'case-a'))).toBe(true)
    expect(path.basename(f)).toBe('rca-exec.md')
  })
})
