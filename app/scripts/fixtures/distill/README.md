# Distillation fixtures

Each `fx-*.json` here is one deterministic distillation + attribution scenario. A fixture holds
a case transcript, the knowledge assets the case used, the canned output of every pipeline
stage, and the database state expected afterwards. The fake headless runner
(`src/main/services/distill/fakeRunner.ts`) answers each stage prompt from the canned stage
text, so the real pipeline, queue, staging and attribution writer all run without the Claude
SDK.

The loader is `scripts/lib/fixtures.mjs`, with its types in `fixtures.d.mts`. Two suites use it:

- the vitest fixture suite, `src/main/services/distill/__tests__/distill.fixtures.integration.test.ts`;
- the deterministic CDP gate, `scripts/cdp-attribution-fake.mjs`.

`listFixtures()` validates every file in this directory. `scripts/lib/__tests__/fixtures.test.mjs`
calls it, so a broken fixture fails `npm test`.

## Schema

| key | type | meaning |
|---|---|---|
| `slug` | string | The case slug, and the name of the per-case stage file the fake reads (`<fakeDir>/<slug>.json`). Unique across the set. |
| `title` | string | Case title. |
| `jiraKey` | string \| null | Jira key. Its project prefix becomes `case_domain` (`FXH-1` gives `FXH`). |
| `scenario` | string | Free text for the report line. |
| `settings.pipeline` | `"v2"` \| `"v3"` | The `distill.pipeline` setting for this fixture. `settingsFor(fx)` also turns on `attribution.default`. |
| `assets.skills[]` | `{ name, description, body }` | Written to `<home>/skills-user/<name>/SKILL.md` with `name:` and `description:` frontmatter. |
| `assets.references[]` | `{ relPath, tier, body }` | Written to `<home>/references/<relPath>`. A non-null `tier` adds `trust_tier:` frontmatter, which is where the inventory reads the tier from. |
| `assets.memories[]` | string | Memory names only. A memory read needs no file. |
| `sessions[]` | `{ title, messages: [{ role, content }] }` | At least 1. Seeded into `sessions`, `messages_fts` and `messages_fts_map`, with one running `turn_id` per case. |
| `findings[]` | `{ summary, reviewState, role, session }` | `session` is an index into `sessions`. |
| `toolCalls[]` | `{ session, turn, tool, detail }` | The asset inventory: `Skill` + skill name, `Read` + `ref:<relPath>`, `mcp__argus__read_memory` + memory name. `turn` is stored as `tool_calls.turn_id` (1-based, as in the paid gate) and must be at most the session's message count. Leave the array empty for a negative control. |
| `close` | `{ resolution, distill, attribution }` \| null | How the case is closed, with the two close-dialog checkboxes. |
| `trigger` | `"redistill"` (optional) | Used instead of `close` for an open-case run. Set exactly one of `close` (non-null) and `trigger`. |
| `stages` | `{ [stage]: { text?, throw?, capHit?, capSubtype?, usage?, turnCount?, toolCallCount? } }` | The fake's `FakeCaseStages`, with placeholders. Stage keys: `dossier`, `dossierLite`, `summary`, `candidates`, `attribution`, `materialize`, `v2`, `rejectDigest`. |
| `actions[]` | `retract-finding` / `reject-proposal` | Applied in order after the close settles. |
| `expected.jobs[]` | `{ kind, state, pipeline, stages, attributionSkipped, attributionError, costUsd }` | Every `distill_jobs` row for the slug, ordered by id, with an exact length. `stages` lists the keys present among `dossier`, `summary`, `candidates`, `attribution`, `materialize` (`materialize` counts only when non-empty). A v2 row with no `stages_json` is read as `{}`. `costUsd` must match to within 1e-6. Must not be empty. |
| `expected.attributions[]` | `{ kind, name, applied, verdict, override, domain, outcome }` | The exact set of `asset_attributions` rows on the case's latest job, keyed by `kind/name`. `override` is `{ verdict, source }` or `null`. |
| `expected.fakeCalls` | `{ [stage]: n }` | Call counts for each named stage in `calls.ndjson`. A missing stage counts as 0, so `0` asserts "never called". |
| `expected.ui` | `{ libraryChip, observabilityLists, observabilityOmits, runsRailLabel, runDetailSkipped }` | Read by the CDP gate only. `checkExpected` does not compare it. |

Default fake usage, when a stage sets no `usage`: one-shot stages cost 0.01 USD, and agent
stages (`dossier`, `dossierLite`, `v2`) cost 0.5 USD. Set `usage.costUsd` explicitly wherever
the expected cost depends on it.

## Placeholders

Row ids are only known after seeding, so canned stage text refers to them by placeholder:

- `"{{finding:i}}"` is replaced by the id of the i-th seeded finding;
- `"{{session:i}}"` is replaced by the id of the i-th seeded session.

Write each placeholder **quoted**, as a JSON string. `resolveStages` replaces the token
*including its quotes* with the number, so `{"finding":"{{finding:0}}"}` becomes
`{"finding":12}`. An unquoted, malformed or out-of-range placeholder is an error.

Cite `turn` values in stage text are literal and are **not** placeholders. They are 0-based
indexes into that session's `messages` array, which is what `citeKnownIn` checks. Turn 1 is the
second message of the session. This is not the same numbering as `toolCalls[].turn`.

## Validator constraints on canned proposal content

A materialized proposal must pass `src/main/services/distill/v3/validators.ts`, or staging
drops it:

- **No case identifiers** (`case-identifiers`). The case slug and Jira key must not appear in
  the proposal body or in a skill's `description:`. The check is a case-insensitive word match,
  and `-` counts as a word boundary. So a skill named `fx-helped-skill` must not repeat its own
  name, or `fx-helped.md`, in its body or description: both contain the slug `fx-helped`.
- **Fewer than 3 numbered steps added to a reference** (`steps-in-reference`).
- **`basis` of at least 20 characters** (`basis`).
- **No whole-file rewrite** (`broad-edit`). Make local edits, such as `append-section` under an
  existing heading. Leave the frontmatter alone.

Two more rules apply to the whole set:

- Asset names are unique across the fixture set: `fx-<scenario>-skill`, `fx-<scenario>.md` and
  `fx-<scenario>-topic`.
- The veto runs before materialize. A `skill-edit` needs its target installed, and a
  `skill-new` whose name is already installed is dropped as `target-exists`.

## How to add a scenario

1. Copy the closest existing fixture to `fx-<scenario>.json`.
2. Rename the slug and every asset (skill, reference, memory, and their mentions in
   `toolCalls` and in the stage text).
3. Write the stages: canned fences for each stage the scenario calls, placeholders for row ids,
   and `usage` wherever the expected cost depends on it. Then write `expected` to match.
4. `npm test -- scripts/lib` validates the set and runs the loader tests.
5. `npm test -- distill.fixtures` runs every fixture through the real queue and pipeline.
6. Run the deterministic CDP gate.
