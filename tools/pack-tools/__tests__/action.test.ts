import { it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

it('action.yml declares the four inputs and invokes the CLI', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8')
  for (const key of ['pack:', 'bin:', 'platform:', 'out:']) expect(text).toContain(key)
  expect(text).toContain('dist/cli.js')
  expect(text.toLowerCase()).toContain('using: "composite"'.toLowerCase())
})
