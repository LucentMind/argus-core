/**
 * The three — and only three — kinds of fact agent memory may hold. Memory is the store that
 * cannot be shared: facts true for THIS user on THIS machine. Anything a teammate would also
 * want is a reference (write_proposal type "reference-edit"); anything about one case belongs
 * to that case. There is deliberately no fourth value: content that helps a teammate has no
 * valid scope, and that absence is the forcing function.
 */
export const MEMORY_SCOPES = ['preference', 'environment', 'correction'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]
