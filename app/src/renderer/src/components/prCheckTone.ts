import type { PrCheck } from '../../../shared/prStatus'

/** Five buckets, five readings. Collapsing `cancelled` into `fail` is the
 *  specific mistake this table exists to prevent: a cancelled run is an absence
 *  of a result, not a bad one, and reading it as failure sends people to debug
 *  a job that never ran.
 *
 *  Lives in its own module rather than beside `BUCKET_MARK` in
 *  `PrCompanionSection.tsx`: `react-refresh/only-export-components` rejects a
 *  component file that exports anything else, so a constant this component
 *  needs to share with its test has to live next door instead (same pattern as
 *  `settings/settingsPages.ts`). */
export const BUCKET_TONE: Record<PrCheck['bucket'], string> = {
  pass: 'text-review border-review/30',
  fail: 'text-danger border-danger/40',
  cancelled: 'text-mute border-dashed border-hair2',
  pending: 'text-defect border-defect/30',
  skipped: 'text-mute border-hair'
}
