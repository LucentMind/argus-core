import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildReferenceIndex, REFERENCE_INDEX_LEAD } from '../referenceIndex'
import { defaultReferenceSync } from '../../../../shared/referenceSync'

let dir: string
const config = defaultReferenceSync()

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refidx-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (rel: string, body: string): void => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

describe('buildReferenceIndex', () => {
  it('is empty when there are no references — nothing to advertise', () => {
    expect(buildReferenceIndex(dir, config)).toBe('')
  })

  it('leads with the registered prose, names the directory, and lists each reference', () => {
    write(
      'log-patterns.md',
      '---\ntitle: log patterns\n---\n# Log patterns\n\nHow to read logcat.\n'
    )
    const out = buildReferenceIndex(dir, config)
    expect(out).toContain(REFERENCE_INDEX_LEAD)
    // The absolute path is the actionable half: it is what the agent passes to Read, and a read
    // resolving inside the references root is what stamps the `ref:` usage row.
    expect(out).toContain(`Directory: ${dir}`)
    expect(out).toContain('- log-patterns.md — log patterns: How to read logcat.')
  })

  it('falls back to the filename when there is no frontmatter title', () => {
    write('untitled.md', 'Just a body line.\n')
    expect(buildReferenceIndex(dir, config)).toContain(
      '- untitled.md — untitled: Just a body line.'
    )
  })

  it('includes nested references by relPath', () => {
    write('protocols/nested.md', '---\ntitle: nested\n---\nBody.\n')
    expect(buildReferenceIndex(dir, config)).toContain('- protocols/nested.md — nested: Body.')
  })

  it('appends routing keywords for the file they target', () => {
    write('tools.md', '---\ntitle: tools\n---\nBody.\n')
    const withRules = {
      ...config,
      spaces: [
        {
          key: 'K',
          name: '',
          homepageId: '',
          includeRoots: [],
          excludedSubtrees: [],
          routingRules: [{ keywords: ['adb', 'logcat'], target: 'tools.md' }]
        }
      ]
    }
    expect(buildReferenceIndex(dir, withRules)).toContain('· keywords: adb, logcat')
  })

  it('caps the summary so one long reference cannot dominate the prompt', () => {
    write('long.md', `---\ntitle: long\n---\n${'x'.repeat(400)}\n`)
    const line = buildReferenceIndex(dir, config)
      .split('\n')
      .find((l) => l.startsWith('- long.md'))!
    expect(line.length).toBeLessThan(220)
  })

  it('caps the entry count and says how many were withheld', () => {
    for (let i = 0; i < 65; i++) write(`ref-${String(i).padStart(3, '0')}.md`, 'Body.\n')
    const out = buildReferenceIndex(dir, config)
    expect(out.split('\n').filter((l) => l.startsWith('- ref-')).length).toBe(60)
    expect(out).toContain('and 5 more')
  })

  it('resolves the lead line through the prompt registry when a resolver is given', () => {
    write('a.md', 'Body.\n')
    const out = buildReferenceIndex(dir, config, (id) =>
      id === 'session.reference-index-lead' ? 'CUSTOM LEAD' : ''
    )
    expect(out.startsWith('CUSTOM LEAD')).toBe(true)
  })

  it('the walk skips a directory named like a reference', () => {
    // NOT the unreadable-entry case: listReferenceFiles requires isFile(), so this never
    // reaches the per-file read at all. Kept as its own statement so the read-failure test
    // below cannot be satisfied by this, which is how it silently passed before.
    write('real.md', 'Kept.\n')
    fs.mkdirSync(path.join(dir, 'ghost.md'))
    const out = buildReferenceIndex(dir, config)
    expect(out).toContain('- real.md')
    expect(out).not.toContain('ghost.md')
  })

  it('skips a file that fails to read rather than killing session construction', () => {
    // buildReferenceIndex runs inline in the CaseSession constructor, so a reference deleted
    // between the directory walk and its read must not take the session down. The fault has to
    // be injected at the READ — a file that vanishes mid-walk cannot be staged on disk, and
    // staging a directory instead is skipped by the walk before the catch is ever reached.
    write('gone.md', 'Vanishes.\n')
    write('real.md', 'Kept.\n')
    const realRead = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: string, ...rest: never[]) => {
      if (String(p).endsWith('gone.md'))
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return (realRead as (p: string, ...r: never[]) => string)(p, ...rest)
    }) as typeof fs.readFileSync)
    try {
      const out = buildReferenceIndex(dir, config)
      expect(out).toContain('- real.md')
      expect(out).not.toContain('- gone.md')
    } finally {
      spy.mockRestore()
    }
  })

  it('does not throw when the references directory is unreadable', () => {
    // listReferenceFiles' readdirSync calls were unguarded, and this runs on the session
    // constructor path — an ENOTDIR/EPERM there would abort session creation, not degrade.
    const notADir = path.join(dir, 'file-not-dir')
    fs.writeFileSync(notADir, 'x')
    expect(() => buildReferenceIndex(notADir, config)).not.toThrow()
    expect(buildReferenceIndex(notADir, config)).toBe('')
  })
})
