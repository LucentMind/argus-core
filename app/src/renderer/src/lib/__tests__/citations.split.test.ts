import { it, expect } from 'vitest'
import { splitCitations } from '../citations'

it('splits text into plain + citation segments', () => {
  expect(splitCitations('HI\n\n[evidence/project-pitch.md:10]')).toEqual([
    { type: 'text', text: 'HI\n\n' },
    { type: 'cite', relPath: 'evidence/project-pitch.md', start: 10, end: 10 }
  ])
})

it('handles a citation in the middle and multiple citations', () => {
  expect(splitCitations('see [evidence/a.log:3] and [findings.md:7] here')).toEqual([
    { type: 'text', text: 'see ' },
    { type: 'cite', relPath: 'evidence/a.log', start: 3, end: 3 },
    { type: 'text', text: ' and ' },
    { type: 'cite', relPath: 'findings.md', start: 7, end: 7 },
    { type: 'text', text: ' here' }
  ])
})

it('returns a single text segment when there is no citation', () => {
  expect(splitCitations('just plain text 3*4=12')).toEqual([
    { type: 'text', text: 'just plain text 3*4=12' }
  ])
})

it('does not match an already-linkified citation (followed by "(")', () => {
  const segs = splitCitations('[evidence/a.log:3](cite://evidence/a.log?line=3)')
  expect(segs.every((s) => s.type === 'text')).toBe(true)
})
