/**
 * The RCA report template: an ordered section list per report, stored in
 * `settings.rca.template` and snapshotted into each `rca_jobs` row at generate time.
 *
 * A `claims` section renders a fixed field of `RcaDraft` — those fields are load-bearing
 * outside the report (`confirm()` feeds the claim arrays to `applyReportRoles`, which writes
 * finding roles), so a template may reorder, rename, or disable such a section but can never
 * remove it from the model contract. A `narrative` section is content the model writes to
 * order from `instruction`.
 */
export type ClaimSlot =
  | 'root-cause'
  | 'contributing'
  | 'symptoms'
  | 'ruled-out'
  | 'timeline'
  | 'remediation'
  | 'tech-narrative'

export interface RcaSection {
  /** Stable slug. For narrative sections this is also the key the model returns content
   *  under (increment 2) and the key `dropped` names (increment 3). Unique within a report. */
  id: string
  /** Rendered as `## <heading>`. */
  heading: string
  kind: 'claims' | 'narrative'
  /** `kind: 'claims'` only — which fixed draft field this section renders. */
  slot?: ClaimSlot
  /** `kind: 'narrative'` only — what the model should write here. */
  instruction?: string
  /** Disabled sections are neither rendered nor asked for in the prompt. */
  enabled: boolean
}

export interface RcaTemplate {
  exec: RcaSection[]
  tech: RcaSection[]
}

/**
 * Ships the exact report shape that predates templates. `render.ts`'s golden tests assert
 * that rendering under this template is byte-identical to the previous hardcoded output —
 * changing anything here changes every user's report, so treat edits as a product decision.
 *
 * The exec instructions carry what used to be RCA_CONTRACT rule 5 (a non-technical reader:
 * no file paths, no code, no finding ids). Increment 2 feeds these instructions to the model;
 * until then they are inert documentation of what each section holds.
 */
export const DEFAULT_RCA_TEMPLATE: RcaTemplate = {
  exec: [
    {
      id: 'what-happened',
      heading: 'What happened',
      kind: 'narrative',
      enabled: true,
      instruction:
        'One short paragraph for a non-technical reader describing what broke, in plain language. No file paths, no code, no finding ids.'
    },
    {
      id: 'impact',
      heading: 'Impact',
      kind: 'narrative',
      enabled: true,
      instruction:
        'Who was affected and how badly, in business terms: which users, for how long, what they experienced. No file paths, no code, no finding ids.'
    },
    {
      id: 'root-cause',
      heading: 'Root cause',
      kind: 'narrative',
      enabled: true,
      instruction:
        'The root cause restated for a non-technical reader — the same conclusion as the technical report, without the mechanism. No file paths, no code, no finding ids.'
    },
    {
      id: 'what-we-did',
      heading: 'What we did',
      kind: 'narrative',
      enabled: true,
      instruction:
        'The immediate action taken to stop the impact. No file paths, no code, no finding ids.'
    },
    {
      id: 'next-steps',
      heading: 'Next steps',
      kind: 'narrative',
      enabled: true,
      instruction:
        'A bullet list of what happens next to keep this from recurring. No file paths, no code, no finding ids.'
    }
  ],
  tech: [
    { id: 'root-cause', heading: 'Root cause', kind: 'claims', slot: 'root-cause', enabled: true },
    {
      id: 'impact',
      heading: 'Impact',
      kind: 'narrative',
      enabled: true,
      instruction:
        'The technical blast radius: which systems, tenants, or requests were affected, and for how long. Cite evidence paths where they support the claim.'
    },
    {
      id: 'contributing',
      heading: 'Contributing factors',
      kind: 'claims',
      slot: 'contributing',
      enabled: true
    },
    {
      id: 'symptoms',
      heading: 'Symptoms & timeline',
      kind: 'claims',
      slot: 'symptoms',
      enabled: true
    },
    { id: 'ruled-out', heading: 'Ruled out', kind: 'claims', slot: 'ruled-out', enabled: true },
    {
      id: 'remediation',
      heading: 'Remediation',
      kind: 'claims',
      slot: 'remediation',
      enabled: true
    },
    {
      id: 'tech-narrative',
      heading: '',
      kind: 'claims',
      slot: 'tech-narrative',
      enabled: true
    }
  ]
}
