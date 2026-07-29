# Captured `gh` output (Plan 5, Task 1)

Everything here was captured from the real `gh` CLI on 2026-07-28 against **public** repositories,
read-only. `gh` version was whatever is installed on this machine, authenticated as `JiaweiHan88`
(scopes: `gist`, `read:org`, `repo`, `workflow`).

`JiaweiHan88/argus-core` has no open PR carrying GitHub Actions checks, so a public repo was used.
No write of any kind was made to any repo.

## `prStatus.graphql.json` — the batched status payload

Command (one alias, `t0`):

```bash
gh api graphql -f query='query { t0: repository(owner: "vitejs", name: "vite") { pullRequest(number: 23097) { number url state isDraft mergeable reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } } } } }'
```

Exit code **0**. stdout is a single line of JSON, 4279 bytes.

`vitejs/vite#23097` was chosen because it carries **both** kinds of context: 20 `CheckRun` nodes and
1 `StatusContext` (a Netlify deploy-preview commit status). It is a draft PR
(`isDraft: true`, `mergeable: "MERGEABLE"`, `reviewDecision: "REVIEW_REQUIRED"`,
`statusCheckRollup.state: "SUCCESS"`).

Check-run states observed: 15 `COMPLETED/SUCCESS`, 3 `COMPLETED/NEUTRAL`, 2 `COMPLETED/SKIPPED`.
No `detailsUrl` came back null in this capture. An earlier probe of `cli/cli#13998` produced
`IN_PROGRESS` with `conclusion: null`, confirming the "not COMPLETED ⇒ pending" branch is reachable.

### Things the plan did not assume, that the capture shows

1. **Check names are NOT unique.** `vitejs/vite#23097` has `Semantic Pull Request` **twice** (two
   different workflow runs, two different job ids). `cli/cli#13998` was far worse: 46 contexts with
   only 20 distinct names — `check-requirements / check-requirements` appeared 5 times,
   `label-external` 4 times. Two consequences, both handled in this branch rather than left to be
   discovered in the app:
   - `PrCompanionSection` must not use the check name as its React list key (duplicate keys drop
     rows silently). It keys on `name + '#' + index` instead.
   - `fetchCheckLogs` resolves a check *by name*. With duplicates, a bare `.find()` picks an
     arbitrary one. It now prefers, among same-named checks, a failing one that has a job id, then
     any one with a job id, then the first — so "analyze the failing X" reaches the failing X. The
     "available checks" list in the unknown-check error is de-duplicated for the same reason.
2. **A `CheckRun` is not necessarily an Actions job.** Netlify posts `CheckRun` nodes whose
   `detailsUrl` is `https://app.netlify.com/...` (`Header rules - vite-docs-main`,
   `Pages changed - …`, `Redirect rules - …`). GitHub also posts CodeQL/zizmor checks whose
   `detailsUrl` is `https://github.com/vitejs/vite/runs/90311353606` — a github.com URL with **no**
   `/actions/runs/<id>/job/<id>` segment. Both correctly yield `null` from `actionsJobId`, which is
   exactly what design decision 8 needs, but it means "CheckRun ⇒ analyzable" would have been wrong.
3. **`contexts(first: 100)` really does truncate.** A probe of `vercel/next.js#96298` returned
   exactly 100 contexts. The plan's page size is kept (a 100-check PR is already unreadable in the
   aside), but the cap is real, not theoretical.

## `prStatus.partial-error.json` — GraphQL partial failure

Command (two aliases; `t1` names a repo that does not exist):

```bash
gh api graphql -f query='query { t0: repository(owner: "vitejs", name: "vite") { pullRequest(number: 23097) { number url state } } t1: repository(owner: "vitejs", name: "definitely-not-a-real-repo") { pullRequest(number: 1) { number url state } } }'
```

**Exit code `1`** — and stdout still carried the complete, parsable body:

```json
{"data":{"t0":{"pullRequest":{…}},"t1":null},
 "errors":[{"type":"NOT_FOUND","path":["t1"],"locations":[…],
            "message":"Could not resolve to a Repository with the name 'vitejs/definitely-not-a-real-repo'."}]}
```

stderr was `gh: Could not resolve to a Repository with the name 'vitejs/definitely-not-a-real-repo'.`

**Design decision 5 is confirmed as written.** `gh` exits non-zero, prints usable JSON on stdout,
`errors[].path[0]` is the failing alias, and the healthy alias's data is intact. No adjustment to
Task 2/Task 3 was needed on this point.

Also verified empirically (not assumed from types): `promisify(execFile)`'s rejection carries the
child's `stdout` as a string property on the Error, so `defaultGhRunner` — which does not catch —
propagates an error whose `.stdout` is that body. `fetchPrStatuses` reading `err.stdout` therefore
works with the production runner, not only with test doubles.

## The Actions job log

```bash
gh api repos/vitejs/vite/actions/jobs/90311344545/logs
```

Exit code **0**, empty stderr. The response is **plain text, not JSON**: 136 543 bytes / 721 lines
for one `Build&Test: node-20, ubuntu-latest` job. The endpoint 302s to a signed blob URL and **`gh`
followed the redirect transparently** — no `--include`, no manual second fetch, nothing in stderr
about it.

Two details worth knowing:

- Each line is prefixed with an RFC-3339 timestamp, e.g.
  `2026-07-28T14:47:14.1596809Z Current runner version: '2.336.0'`, and `##[group]` / `##[endgroup]`
  markers appear inline. Ingested as-is; no parsing is attempted.
- **The body begins with a UTF-8 BOM (U+FEFF).** Harmless for ingest, but it means a naive
  `text.startsWith('2026-')` or a JSON.parse attempt on the first byte would surprise someone.

136 KB is comfortably under the 2 MB truncation threshold, so the truncation path is exercised by
the unit test rather than by a real capture. This log was not committed — it is large, it is
somebody else's build output, and no test asserts against it.

## 2026-07-29 captures — check vocabulary (cancelled / required)

Same posture as the Plan 5 capture above: real `gh` (2.96.0) against public repositories,
read-only, no write of any kind. Two of the three pin a commit OID, because check runs on a
completed commit do not change.

### `prStatus.required.json` — `isRequired` on both node types

`cli/cli#14003`, `contexts(first: 8)`. Six check runs: the three `build (…)` matrix jobs carry
`isRequired: true`, the three `integration-tests (…)` jobs `false`. Also the first capture of
`mergeStateStatus` (`CLEAN` here).

`isRequired` needs **no admin rights** — this was read with ordinary public-repo access, which
settles the question of whether Argus can ask it for a repository the user does not own.

### `prStatus.cancelled.json` — cancelled alongside a genuine failure

`home-assistant/core@becc3107`, `contexts(first: 20)`. `Check hassfest` failed; `Check pylint`
and `Check pylint on tests` were `CANCELLED` as collateral (the concurrency group killed them).
The full commit reports `CANCELLED=2 FAILURE=1 SKIPPED=7 SUCCESS=16`. Before this change all
three of the non-green runs rendered as identical red rows with equally prominent Analyze
buttons, though two of their logs contain only the cancellation.

### `prStatus.nullNodes.json` — what a field-level error does to the response

Captured by deliberately omitting `isRequired`'s required argument. The finding that shaped
`fetchPrStatuses`: GraphQL returns **the pull request node intact and every context node as
`null`**, with one error per node. `gh` exits 1 and still prints the whole body.

The `if (!pr)` guard does not fire for this shape, so mapping the contexts without a null check
would throw inside `targets.forEach` and take down every other target in the batch. One error
per node also means a 100-check PR yields 100 identical messages, so only the first is kept.
