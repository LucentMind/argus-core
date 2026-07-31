import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { EditorCorpusService, type CorpusDeps } from '../editorCorpus'

const HOME = path.join('/argus')
const REFS = path.join(HOME, 'references')

function svc(over: Partial<CorpusDeps> = {}): EditorCorpusService {
  const files: Record<string, string> = {
    [path.join(REFS, 'jira-fields.md')]: '---\ntitle: Jira fields\ntrust_tier: user\n---\nbody\n',
    [path.join(REFS, 'routing.md')]: 'no frontmatter, mentions jira-fields.md on this line\n',
    [path.join(REFS, 'INDEX.md')]: '# References index\n- [Jira fields](jira-fields.md) — x\n',
    [path.join(HOME, 'skills-user', 'triage', 'SKILL.md')]: 'read jira-fields.md before triaging\n'
  }
  return new EditorCorpusService({
    argusHome: HOME,
    listSkills: () => [
      {
        name: 'triage',
        dir: path.join(HOME, 'skills-user', 'triage'),
        description: 'Triage a case',
        tier: 'user'
      }
    ],
    fs: {
      readDir: (dir) =>
        dir === REFS ? ['jira-fields.md', 'routing.md', 'INDEX.md', 'notes.txt'] : [],
      readFile: (f) => {
        const hit = files[f]
        if (hit === undefined) throw new Error(`ENOENT ${f}`)
        return hit
      }
    },
    ...over
  })
}

describe('EditorCorpusService.list', () => {
  it('returns skills with their description and tier', () => {
    expect(svc().list()).toContainEqual({
      kind: 'skill',
      name: 'triage',
      title: '',
      description: 'Triage a case',
      tier: 'user'
    })
  })

  it('returns references with their frontmatter title and tier', () => {
    expect(svc().list()).toContainEqual({
      kind: 'reference',
      name: 'jira-fields.md',
      title: 'Jira fields',
      description: '',
      tier: 'user'
    })
  })

  it('reports an untagged reference as tier null, not as a missing row', () => {
    const row = svc()
      .list()
      .find((r) => r.name === 'routing.md')
    expect(row).toEqual({
      kind: 'reference',
      name: 'routing.md',
      title: '',
      description: '',
      tier: null
    })
  })

  it('includes INDEX.md — quick open lists it so it can be read', () => {
    expect(
      svc()
        .list()
        .map((r) => r.name)
    ).toContain('INDEX.md')
  })

  it('ignores non-markdown files in the references directory', () => {
    expect(
      svc()
        .list()
        .map((r) => r.name)
    ).not.toContain('notes.txt')
  })

  it('skips a reference that cannot be read, keeping the rest of the corpus', () => {
    // A file listed by readdir and unreadable a moment later is a delete mid-scan. The SKILLS
    // still come back — they come from `listSkills`, which reads no files.
    const s = svc({
      fs: {
        readDir: () => ['gone.md'],
        readFile: () => {
          throw new Error('ENOENT')
        }
      }
    })
    expect(s.list().map((r) => r.name)).toEqual(['triage'])
  })

  it('survives a missing references directory', () => {
    const s = svc({
      fs: {
        readDir: () => {
          throw new Error('ENOENT')
        },
        readFile: () => ''
      }
    })
    expect(s.list().map((r) => r.kind)).toEqual(['skill'])
  })
})

describe('EditorCorpusService.findReferences', () => {
  it('finds mentions across both skills and references', () => {
    const hits = svc().findReferences({ kind: 'reference', name: 'jira-fields.md' })
    expect(hits).toContainEqual({
      kind: 'reference',
      name: 'routing.md',
      line: 1,
      text: 'no frontmatter, mentions jira-fields.md on this line'
    })
    expect(hits).toContainEqual({
      kind: 'skill',
      name: 'triage',
      line: 1,
      text: 'read jira-fields.md before triaging'
    })
  })

  it('finds the INDEX.md link, which is the one convention that actually exists', () => {
    const hits = svc().findReferences({ kind: 'reference', name: 'jira-fields.md' })
    expect(hits.some((h) => h.name === 'INDEX.md')).toBe(true)
  })

  it('never reports the asset citing itself', () => {
    const hits = svc().findReferences({ kind: 'reference', name: 'jira-fields.md' })
    expect(hits.some((h) => h.kind === 'reference' && h.name === 'jira-fields.md')).toBe(false)
  })

  it('returns nothing for an asset that is not in the corpus', () => {
    expect(svc().findReferences({ kind: 'reference', name: 'nope.md' })).toEqual([])
  })

  it('sorts skills before references, then by name, then by line', () => {
    const hits = svc().findReferences({ kind: 'reference', name: 'jira-fields.md' })
    expect(hits.map((h) => `${h.kind}:${h.name}`)).toEqual([
      'skill:triage',
      'reference:INDEX.md',
      'reference:routing.md'
    ])
  })

  it('calls listSkills exactly once per findReferences call, regardless of corpus size', () => {
    // Production listSkills is a closure over resolveSkills(), which does a readdirSync per
    // tier plus a readFileSync per skill on every invocation. body() used to re-derive a
    // skill's dir by calling listSkills() again for every skill item in the corpus, turning
    // one findReferences() call into N+1 listSkills() calls for N skills. Pin the count so a
    // regression back to that shape fails loudly instead of merely "being slower".
    const listSkills = vi.fn(() => [
      {
        name: 'triage',
        dir: path.join(HOME, 'skills-user', 'triage'),
        description: 'Triage a case',
        tier: 'user'
      },
      {
        name: 'other',
        dir: path.join(HOME, 'skills-user', 'other'),
        description: 'Another skill',
        tier: 'user'
      }
    ])
    const files: Record<string, string> = {
      [path.join(REFS, 'jira-fields.md')]: '---\ntitle: Jira fields\ntrust_tier: user\n---\nbody\n',
      [path.join(HOME, 'skills-user', 'triage', 'SKILL.md')]:
        'read jira-fields.md before triaging\n',
      [path.join(HOME, 'skills-user', 'other', 'SKILL.md')]: 'unrelated content\n'
    }
    const s = new EditorCorpusService({
      argusHome: HOME,
      listSkills,
      fs: {
        readDir: (dir) => (dir === REFS ? ['jira-fields.md'] : []),
        readFile: (f) => {
          const hit = files[f]
          if (hit === undefined) throw new Error(`ENOENT ${f}`)
          return hit
        }
      }
    })
    s.findReferences({ kind: 'reference', name: 'jira-fields.md' })
    expect(listSkills).toHaveBeenCalledTimes(1)
  })
})
