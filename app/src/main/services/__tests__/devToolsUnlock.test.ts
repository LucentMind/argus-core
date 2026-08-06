import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { readDevToolsUnlocked, writeDevToolsUnlocked } from '../devToolsUnlock'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-devtools-unlock-'))
}

describe('devToolsUnlock', () => {
  it('reads not-unlocked when no marker file exists', () => {
    expect(readDevToolsUnlocked(tmpHome())).toBe(false)
  })

  it('reads unlocked after writeDevToolsUnlocked', () => {
    const home = tmpHome()
    writeDevToolsUnlocked(home)
    expect(readDevToolsUnlocked(home)).toBe(true)
  })

  it('reads not-unlocked from a malformed marker file', () => {
    const home = tmpHome()
    fs.mkdirSync(path.join(home, 'config'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config', 'dev-tools-unlock.json'), '{ not json', 'utf8')
    expect(readDevToolsUnlocked(home)).toBe(false)
  })

  it('reads not-unlocked when the marker holds an unrelated shape', () => {
    const home = tmpHome()
    fs.mkdirSync(path.join(home, 'config'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'config', 'dev-tools-unlock.json'),
      JSON.stringify({ unlocked: 'yes' }),
      'utf8'
    )
    expect(readDevToolsUnlocked(home)).toBe(false)
  })
})
