import { describe, it, expect } from 'vitest'
import { DISTILL_TOOL_DESCRIPTORS } from '../worldTools'
import { DISTILL_TOOL_SCHEMAS } from '../mcp'

/**
 * `DISTILL_TOOL_DESCRIPTORS` (worldTools.ts, hashed into the distill prompt surface per
 * Task 9) and the zod param schemas `createDistillMcpServer` actually registers (mcp.ts) are
 * two independent representations of the same tool surface — nothing else keeps them in sync.
 * A param added to one and forgotten in the other would silently drift: the descriptor's
 * `params` list is prompt-facing documentation only, while the zod shape is what the SDK
 * actually validates/passes through, so a mismatch would misdescribe the real tool to the model
 * without either side raising an error. This test hashes them together.
 */
describe('distill tool descriptors <-> zod schemas conformance', () => {
  it('every descriptor has a matching zod schema entry', () => {
    const descriptorNames = DISTILL_TOOL_DESCRIPTORS.map((d) => d.name).sort()
    const schemaNames = Object.keys(DISTILL_TOOL_SCHEMAS).sort()
    expect(descriptorNames).toEqual(schemaNames)
  })

  it.each(DISTILL_TOOL_DESCRIPTORS.map((d) => [d.name, d] as const))(
    '%s: descriptor params match the zod schema keys',
    (name, descriptor) => {
      const schema = DISTILL_TOOL_SCHEMAS[name]
      expect(schema).toBeDefined()
      expect([...descriptor.params].sort()).toEqual(Object.keys(schema).sort())
    }
  )
})
