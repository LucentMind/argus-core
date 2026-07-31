import type { PrCheck } from '../../../shared/prStatus'

/** Five buckets, five readings. Collapsing `cancelled` into `fail` is the
 *  specific mistake this table exists to prevent: a cancelled run is an absence
 *  of a result, not a bad one, and reading it as failure sends people to debug
 *  a job that never ran.
 *
 *  Text colour only: the mark renders as a bare `aria-hidden` character (see
 *  `CheckRow` in `PrCompanionSection.tsx`), with no border-width or padding
 *  utility alongside it, so a `border-*`/`border-dashed` token here paints a
 *  0px border — colour and style with nothing to show them. A previous
 *  version of this table carried those tokens anyway (dead classes, kept
 *  "for later"). Turning the mark into an actual bordered chip was considered
 *  instead of deleting them, but check rows are already tight at the rail's
 *  real width (~300px, often several checks with long GitHub Actions names
 *  competing with `truncate`), and every other single-glyph CI indicator in
 *  this app (`PrRollupDot`/`PrRollupIcon`) reads by colour and shape alone,
 *  never a box around the glyph — so five colours, no borders, matches both
 *  the space budget and the app's own vocabulary for this signal.
 *
 *  Lives in its own module rather than beside `BUCKET_MARK` in
 *  `PrCompanionSection.tsx`: `react-refresh/only-export-components` rejects a
 *  component file that exports anything else, so a constant this component
 *  needs to share with its test has to live next door instead (same pattern as
 *  `settings/settingsPages.ts`). */
export const BUCKET_TONE: Record<PrCheck['bucket'], string> = {
  pass: 'text-review',
  fail: 'text-danger',
  cancelled: 'text-mute',
  pending: 'text-defect',
  skipped: 'text-mute'
}
