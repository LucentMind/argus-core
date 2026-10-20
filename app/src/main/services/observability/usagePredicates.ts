/** The ONE place the "which tool_calls row counts as an activation" rule lives. `usageStats()`
 *  (Observability) and `buildAssetInventory()` (distill attribution) both read these — if they
 *  ever disagreed, the Library would count an activation the judge never saw, or vice versa. */
export const USAGE_PREDICATES = {
  skill: "tool = 'Skill'",
  memory: "tool = 'mcp__argus__read_memory'",
  reference: "detail LIKE 'ref:%'"
} as const
export const EFFECTIVE_CALLS = "detail IS NOT NULL AND decision NOT IN ('denied','cancelled')"
