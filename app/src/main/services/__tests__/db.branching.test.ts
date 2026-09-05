import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../db'

let home: string
let db: DatabaseSync
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-branch-schema-'))
  db = openDb(path.join(home, 'argus.db'))
})
afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const cols = (t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)

describe('branching schema', () => {
  it('adds the three turn columns', () => {
    expect(cols('turns')).toEqual(
      expect.arrayContaining(['rewound_at', 'rewound_to_turn_id', 'provider_anchor_id'])
    )
    expect(cols('turns')).not.toContain('provider_user_message_id') // V9: resolved at rewind time, never stored
  })
  it('adds the five session columns', () => {
    expect(cols('sessions')).toEqual(
      expect.arrayContaining([
        'forked_from_session_id',
        'forked_at_turn_id',
        'forked_inherited_turns',
        'pre_rewind_cursor',
        'forked_branching'
      ])
    )
  })
  it('is idempotent on a second open', () => {
    db.close()
    db = openDb(path.join(home, 'argus.db'))
    expect(cols('turns')).toContain('rewound_at')
  })
})
