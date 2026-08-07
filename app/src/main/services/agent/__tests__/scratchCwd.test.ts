import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { agentScratchCwd } from '../scratchCwd'

describe('agentScratchCwd', () => {
  it('is a dedicated subdirectory, never the temp root itself — the CLI walks its cwd at boot and a long-lived %TEMP% holds hundreds of thousands of entries', () => {
    const dir = agentScratchCwd()
    expect(dir).not.toBe(os.tmpdir())
    expect(path.dirname(dir)).toBe(os.tmpdir())
  })

  it('exists after the call — a temp sweeper may have removed it between spawns', () => {
    const dir = agentScratchCwd()
    fs.rmSync(dir, { recursive: true, force: true })
    expect(fs.existsSync(agentScratchCwd())).toBe(true)
  })

  it('falls back to the temp root rather than throwing when the directory cannot be created — a spawn with a busy cwd beats no spawn at all', () => {
    const boom = (): never => {
      throw new Error('EROFS')
    }
    expect(agentScratchCwd(boom)).toBe(os.tmpdir())
  })
})
