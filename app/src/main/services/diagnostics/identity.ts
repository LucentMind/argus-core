/** Half of every identity in this feature: a pid alone is not unique over time. */
export function identityKey(pid: number, startTimeMs: number): string {
  return `${pid}:${startTimeMs}`
}
