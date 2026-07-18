// The normalizer moved to drivers/claude/normalize.ts (Claude's SDK message shapes are
// Claude-specific). This shim keeps existing importers (session.ts, normalize.test.ts)
// working until Task 4 repoints them; delete then.
export * from './drivers/claude/normalize'
