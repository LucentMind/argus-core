import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeProposal, acceptProposal } from '../proposals'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prop-target-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('acceptProposal return value', () => {
  it('reference-edit → reference kind with .md file name', () => {
    const f = writeProposal(home, 'c', {
      type: 'reference-edit',
      target: 'notes',
      title: 'T',
      content: 'b'
    })
    expect(acceptProposal(home, f)).toEqual({ kind: 'reference', name: 'notes.md' })
  })

  it('recipe with .md-suffixed target does not double the extension', () => {
    const f = writeProposal(home, 'c', {
      type: 'recipe',
      target: 'howto.md',
      title: 'T',
      content: 'b'
    })
    expect(acceptProposal(home, f)).toEqual({ kind: 'reference', name: 'howto.md' })
  })

  it('skill-new → skill kind with the directory name', () => {
    const f = writeProposal(home, 'c', {
      type: 'skill-new',
      target: 'my-skill',
      title: 'T',
      content: 'b'
    })
    expect(acceptProposal(home, f)).toEqual({ kind: 'skill', name: 'my-skill' })
  })
})
