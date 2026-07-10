import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentAccessStore } from '../agentAccess'
import { applyMemoryWrite, listTopics, readIndex, MEMORY_INDEX_MAX_LINES } from '../memory'
import { resolveSkills } from '../agent/skillsResolver'
import { topicEnabled } from '../../../shared/agentAccess'

let tmp: string, argusHome: string, store: AgentAccessStore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-aip-'))
  argusHome = path.join(tmp, 'home')
  store = new AgentAccessStore(argusHome)
})

afterEach(() => {
  store.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

it('memory topics payload joins enablement from the access store', () => {
  applyMemoryWrite(argusHome, 'NAV-1', { topic: 'a', content: 'x', indexEntry: 'a' })
  applyMemoryWrite(argusHome, 'NAV-1', { topic: 'b', content: 'y', indexEntry: 'b' })
  store.patch({ memory: { b: false } })
  const access = store.get()
  const topics = listTopics(argusHome).map((t) => ({ ...t, enabled: topicEnabled(access, t.name) }))
  expect(topics.map((t) => [t.name, t.enabled])).toEqual([
    ['a', true],
    ['b', false]
  ])
  expect(
    readIndex(argusHome)
      .split('\n')
      .filter((l) => l.trim()).length
  ).toBeLessThanOrEqual(MEMORY_INDEX_MAX_LINES)
})

it('skills payload reflects access toggles live', () => {
  const root = path.join(argusHome, 'skills', 'demo')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n')
  expect(resolveSkills(argusHome, store.get())[0].enabled).toBe(true)
  store.patch({ skills: { 'bundled/demo': false } })
  expect(resolveSkills(argusHome, store.get())[0].enabled).toBe(false)
})
