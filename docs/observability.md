# Observability

Argus can export what its agent does — traces, cost, latency and a handful of scores — to an
external backend.
It is **off by default unless your organization's policy enables a provider**: nothing leaves the machine until a provider is enabled and complete, either by you in **Settings → Observability** or by an [org policy](#org-policy) file IT installs on the machine.
Backends are *providers*; three exist today, Datadog LLM Observability, Langfuse and OpenTelemetry (OTLP/HTTP), and any number can be on at once.

## What Argus sends

Per agent session, one trace:

| Signal | Name | Notes |
|---|---|---|
| Trace root | `<case slug> · session <id>` | Grouped by case (Langfuse session id / `gen_ai.conversation.id` / Datadog `session_id`). A resumed session adds a `session resumed` event to the existing trace. |
| Generation | `turn` | One per completed turn: model, input/output tokens, cost (USD), start and end time. |
| Tool call | the tool's name | Start/end time; an erroring call is marked as an error. |
| Event | `session error` (level ERROR) | Carries the error message. |
| Score | `hitl_approved` (1 / 0) | A permission request was allowed / denied. |
| Score | `turn_error` (1) | A turn ended in error. |
| Score | `finding_accepted` (1 / 0) | A finding was accepted (1) or rejected (0) on review, by the human or by the agent withdrawing its own finding. One score per finding — id `sha256(installId|finding|findingId)[:32]`, so a re-review upserts. Metadata: `findingId`, `caseSlug`, `mode`, `role`, `actor` (`human` / `agent`), `tag` (`wrong` / `not-useful` / `other` / null), `installId`. The comment (the human note, or the agent's reason) is sent only with `captureContent`. Pending findings are not scored. |
| Score | `asset.contribution` (1 / 0 / −1) | Distillation's per-asset verdict: did a skill, reference or memory help or mislead a case. Silent verdicts are not scored. |

Per distill job ATTEMPT (case job, attribution-only job, reject-digest job, dry run), one trace
with the seed `argus-distill-job-<id>@<finished_at>` (the row's id and its `finished_at`
timestamp; plain `argus-distill-job-<id>` for a row with no `finished_at`), grouped under the case
like the agent traces. It is emitted once per terminal job row (done, failed, cancelled, or
recovered on boot), and again only if the job is retried. A retry re-runs the same row id but
finishes at a new time, so it is a **new trace**; the failed attempt's trace is left as it was:

| Signal | Name | Notes |
|---|---|---|
| Trace root | `distill <case slug>` (`distill:attribution <slug>`, `distill:reject-digest`) | Metadata: job id, kind, pipeline, state (done / failed / cancelled), dry run, prompt hash, item count, cost, duration, turn and tool-call counts, error, install id, app version, case domain and outcome, and per-stage prompt hash / prompt chars / validator flags / error under `stages`. At an OTLP backend the root span is `invoke_agent <name>` and each metadata key is the attribute `argus.<camelCase key>` (`argus.jobId`, `argus.costUsd`, `argus.stages` as JSON, ...). |
| Generation | `stage <name>` (`stage materialize <type> <target>`) | One per recorded stage: the distill model, tokens, cost, start/end reconstructed from the recorded durations (sequential approximation: dossier, then summary / candidates / attribution in parallel, then materialize). OTLP spans are named `chat <model>` and carry the stage name as `argus.span.name`. |
| Event | `stage <name> error` (level ERROR) | The stage's error message. |
| Event | `drops`, `parser drops`, `attribution skipped`, `stages unreadable` | Drop counts by stage and reason; dossier / candidates / attribution parser counters; why attribution did not run; a corrupt `stages_json`. |
| Score | `proposal.outcome` (1 / 0.5 / 0) | A proposal was accepted / accepted with edits / rejected. "Edited" means the proposal's own text was changed; an accept whose only edits are to sibling files (`editedFiles`) counts as `accepted`. Attached to the trace of the job attempt that produced it if that job row still exists for the same case (a proposal belongs to the row's latest attempt: a failed run stages nothing and a done job cannot be retried), otherwise to the case's latest session (a human-authored proposal); dropped if the case has no session. Metadata: `argus.proposal.type`, `argus.proposal.target`, `argus.proposal.outcome`, `argus.proposal.edited`, `argus.proposal.reject_reason`, `argus.case.slug`, `argus.job.id`, `argus.install.id`, `argus.app.version`; the first line of a reject note is the comment. Id = `sha256(install id | proposal file | proposal date)`: one id per proposal WRITE (the record's `date` is stamped once when the proposal is written, and file names are reused after a proposal is archived, so a re-distill that reuses a name gets a new id). OTLP consumers deduplicate on `argus.score.id`. Deleting a pending proposal emits nothing. |

Error strings on a distill trace (job and stage errors) are cut to their first line, then at
their first quote character of any kind (`"`, `'` or `` ` ``) with `…` appended, then to 300
characters — so `Unexpected token 'H', "Here is th"... is not valid JSON` becomes
`Unexpected token …`. Parser errors can quote the model's output, and that output can itself
contain quotes, so nothing after the first quote is kept. This is independent of
`captureContent`: error strings travel as metadata, which no adapter strips.

An `asset.contribution` score carries the verdict's explanation as its comment and these
metadata keys: `argus.asset.kind`, `argus.asset.name`, `argus.asset.tier`, `argus.case.domain`,
`argus.case.outcome`, `argus.case.slug`, `argus.install.id`, `argus.app.version`,
`argus.judge.model`, `argus.judge.prompt_hash`, and `argus.override.source` when a human
corrected the judge. See [distillation.md](distillation.md) §1.6 for what the verdicts mean.

**What `captureContent` gates.** With it off (the default) nothing a user or the model wrote
leaves the machine: no prompt (the user's turn text), no completion (the assistant's text) and no
tool output preview, and no stage raw output of a distill job (the model's JSON for the dossier,
summary, candidates, attribution and materialize stages). Token counts, cost, timings, tool names,
case slugs and asset names are still sent. With it on, the turn's input and output and each tool's output preview are added to the
spans, and each distill `stage` generation carries that stage's raw output as its output. The switch is per provider.

## Providers

Settings → Observability shows one section per provider, generated from the descriptors in
`app/src/shared/observabilityProviders.ts`. Each section has an **Enable** toggle, the provider's
fields, a **Capture content** switch (with a privacy warning) and a **Test connection** button
(disabled until the provider is enabled).

| Provider | Fields | Secret (encrypted store) |
|---|---|---|
| Datadog LLM Observability | Site (`datadoghq.com` default), ML app (`argus` when blank), Environment (optional) | `observability/datadog/api-key` |
| Langfuse | Host URL, Public key | `observability/langfuse/secret-key` |
| OpenTelemetry (OTLP/HTTP) | Endpoint, Protocol (`http/protobuf` default, or `http/json`) | `observability/otlp/authorization` (optional) |

Secrets never live in `settings.json`; the stored settings are under
`observability.providers.<id>` (`enabled`, the plain fields, `captureContent`).

A provider is **enabled and complete** when its toggle is on and every required field and secret
is present (Langfuse: host, public key, secret key; OTLP: endpoint; Datadog: API key). Only such a provider gets a
sink. Every **enabled** provider, complete or not, gets a health row named `observability:<id>`
(this row is what **Test connection** runs), and the check reports, in order:

- the sink could not be built (for example a malformed URL) → fail, the constructor error;
- a required field or secret is missing → fail, `not configured: missing <field>` (no probe);
- otherwise the provider's probe. A passing probe appends the live sink's last export error
  (`… · last export error: …`; the settings chip then reads **ok · export error**), so a green
  connection that is still failing to ingest says so. For OTLP a later successful export clears
  that error.

Settings and secrets are read when the sink is built, so saving a field, toggling a switch, or
saving/deleting a provider secret rebuilds the exporter immediately — no restart needed.

**Several providers at once.** Every intent is forwarded to every enabled sink (`FanOutSink`);
one failing adapter never starves another, and flush/shutdown settle independently. The event
reducer runs with `captureContent` = OR over the enabled providers, and each adapter strips
input, output and tool results itself when its own flag is off — so enabling content capture for
one backend does not leak it to another.

**Do not point two providers at the same Langfuse project.** Enabling the Langfuse provider *and*
the OTLP provider aimed at that same project's OTLP endpoint sends everything twice: both adapters
derive the same trace id, so one trace shows two roots and every generation, tool call and score
in duplicate. Use one or the other per project.
The same holds for Datadog: do not enable the Datadog provider *and* point the OTLP provider at a Datadog Agent or Collector for the same org, or every session arrives twice.

**Upgrading.** The old `observability.langfuse` block is moved once, on first start, to
`observability.providers.langfuse` (stamp `migrations.observabilityProvider`; the legacy key is
removed). The Langfuse secret name is unchanged, so nothing needs re-entering.

## Langfuse

Works with Langfuse cloud or a self-hosted instance: set the host (for example
`https://cloud.langfuse.com`), the public key (`pk-lf-…`) and the secret key (`sk-lf-…`). **Test
connection** calls `GET <host>/api/public/projects` with HTTP Basic auth. Unlike the
unauthenticated `/api/public/health`, this fails on bad keys or the wrong regional host.

Scores use deterministic ids: the first 32 hex of `sha256(install id | case | asset kind | asset
name)` for `asset.contribution`. The id is identical across adapters (OTLP carries it as
`argus.score.id`). Langfuse **upserts** by id, so an override or a redistill replaces the score
instead of adding a contradicting second one. OTLP has no upsert — see *Re-emitted scores* below.

## OpenTelemetry (OTLP/HTTP)

Sends spans using the OpenTelemetry GenAI semantic conventions (still *Development* status; all
attribute names are pinned in `providers/otlp/semconv.ts`, so an upstream rename is one edit).
Resource attributes: `service.name=argus`, `service.version=<app version>`, `argus.install.id`.

**Protocol and endpoint.** `http/protobuf` (default) uses `@opentelemetry/exporter-trace-otlp-proto`;
`http/json` uses `@opentelemetry/exporter-trace-otlp-http`. The endpoint is the base URL;
`/v1/traces` is appended unless it is already there (`http://localhost:4318` and
`http://localhost:4318/v1/traces` are equivalent).

**Authorization.** The optional secret is sent verbatim as the `Authorization` header value —
for example `Bearer <token>` or `Basic <base64>`. It is the only header the field can set.

**Pointing it at a backend**

- *Grafana Alloy / Tempo, or any OpenTelemetry Collector* — endpoint is the collector's OTLP/HTTP
  receiver, typically `http://<host>:4318`.
- *Langfuse's OTLP endpoint* — endpoint `https://<langfuse host>/api/public/otel`, Authorization
  `Basic <base64(publicKey:secretKey)>`.
- *Datadog* — use the [Datadog LLM Observability](#datadog-llm-observability) provider instead.
  It sends to Datadog's native intake, so sessions, evaluations, tokens and cost arrive as LLM Observability data rather than generic spans.

### Mapping

Every intent already carries its own start and end time, so each becomes one span started and
ended at once. Argus never keeps a span open across intents: a crash loses nothing already
emitted, and every span, root included, is exported on the next flush.

| Intent | Span / event | Attributes |
|---|---|---|
| `trace-root` | Span `invoke_agent <name>`, kind `CLIENT`, zero-length | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=argus`, `gen_ai.conversation.id=<case slug>`, `argus.case.slug`, root metadata as `argus.*` (`argus.caseSlug`, `argus.caseId`). |
| `generation` | Child span `chat <model>`, kind `CLIENT`, from the intent's start to end | `gen_ai.operation.name=chat`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `argus.cost_usd`. Only with `captureContent`: span events `gen_ai.input.messages` / `gen_ai.output.messages` carrying the text as a JSON message list. |
| `tool` | Child span `execute_tool <name>`, from start to end | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`; `isError` sets span status `ERROR`; only with `captureContent`: `gen_ai.tool.call.result`. |
| `event` | Zero-length child span `event <name>` carrying a span event named `<name>` | `argus.level` (`DEFAULT` or `ERROR`) plus the intent's metadata as attributes. |
| `score` | Zero-length child span `evaluation <name>` (`gen_ai.operation.name=evaluation`) carrying the span event `gen_ai.evaluation.result` | `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value`, `gen_ai.evaluation.explanation` (the comment), the intent's metadata verbatim (so `argus.*` keys survive), and `argus.score.id` when the intent has a deterministic id (the same id Langfuse uses; a re-emit is a new span with the same id — deduplicate on it). |

**Re-emitted scores.** An override or a redistill emits the `asset.contribution` score again with
the same `argus.score.id`. Unlike Langfuse, an OTLP backend cannot upsert: it receives a **new**
`evaluation asset.contribution` span every time. OTLP consumers must deduplicate on
`argus.score.id` (latest span wins) to get one verdict per case and asset.

**Trace identity.** The trace id is `sha256(seed)` truncated to 32 hex, the same derivation the
Langfuse sink uses. A session's seed is `argus-session-<session id>@<install id>` and a distill
job's is `argus-distill-job-<id>@<finished_at>`: both are install-scoped, because session and job
row ids start at 1 in every Argus home and a backend shared by several installs would otherwise
merge every install's session N into one trace. The root is started under a synthetic parent `{trace id, synthetic span id}`
derived from the seed, ended immediately, and only its span context is cached. A child, event or
score arriving with no cached root (for example after an app restart, for a session whose root
was exported in an earlier run) attaches to that same synthetic parent: it lands in the right
trace and nothing creates a placeholder root. The synthetic parent itself is never exported, so
every exported root carries a `parentSpanId` that no span has; some trace UIs (Tempo, Jaeger)
flag such traces as "root span not received". That is expected, not data loss.

**Test connection.** OTLP has no credential endpoint, so the probe is a real export: one
`argus.probe` span through a throw-away exporter, with a 5 s timeout. Success reports
`exported 1 span to <url>`; a 401, 404 or refused connection surfaces as the exporter's error.

## Datadog LLM Observability

Sends to Datadog LLM Observability's native HTTP intake, with no Datadog Agent or Collector on the machine:

- spans: `POST https://api.<site>/api/intake/llm-obs/v1/trace/spans`;
- evaluations: `POST https://api.<site>/api/intake/llm-obs/v2/eval-metric`;
- both authenticated with the `DD-API-KEY` header.

**Fields.**
*Site* is the Datadog site your org lives on (`datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com`).
*ML app* is the LLM Observability application name, `argus` when blank.
It must follow Datadog's naming rule (lowercase; letters, digits and `_ - : . /`; at most 193 characters; no `__` and no trailing `_`); an invalid name fails the health row with the reason instead of sending.
*Environment* is optional and becomes the `env:<value>` tag.
Use a dedicated API key for Argus with a usage monitor on it, so a leaked key can be spotted and revoked on its own.

**Buffering.** Records are buffered in memory and sent every 5 s, on flush (rebuild, quit), or as soon as a buffer passes 1 MB or 500 records.
A failed request drops that chunk and shows as the health row's last export error until a later request succeeds.
Datadog rejects spans older than 24 h; Argus emits each intent near-real-time, so this does not bite in practice.

Every payload carries the tags `service:argus`, `version:<app version>`, `argus.install_id:<id>`, and `env:<value>` when set.

### Mapping

| Intent | Datadog |
|---|---|
| `trace-root` | Span kind `agent`, `parent_id: "undefined"`, `session_id` = case slug (so a case's sessions group as one LLM Observability session), metadata as `argus.*` keys (objects JSON-encoded) plus `argus.case.slug`. |
| `generation` | Span kind `llm`, `model_name`, `model_provider` (`anthropic` for `claude-*`, otherwise omitted), metrics `input_tokens`, `output_tokens`, `total_tokens`, `total_cost`. Only with `captureContent`: `input.messages` / `output.messages`. |
| `tool` | Span kind `tool`; an erroring call sets `status: "error"` and `meta.error.message`. Only with `captureContent`: `output.value`. |
| `event` | Zero-length span kind `task` named `<name>`, metadata in `meta.metadata` with `argus.level`; level `ERROR` sets `status: "error"` and the message as `meta.error.message`. |
| `score` | Evaluation `metric_type: "score"`, `eval_scope: "trace"`, joined on the trace's root span, `score_value` = the value, `reasoning` = the comment, tags = the score metadata plus `argus.score.name:<name>` and `argus.score.id:<id>`. |

Evaluation labels follow Datadog's rule (ASCII letters, digits, `_`, `-`), so dots become underscores: `asset.contribution` is `asset_contribution` and `proposal.outcome` is `proposal_outcome`; the original name is kept as `argus.score.name`.
Whether a score's comment is sent is decided before the adapter (for `finding_accepted` only with `captureContent`), as for every provider.

**Identity.** The trace id is the same 32-hex `sha256(seed)` derivation the other adapters use (Datadog accepts 128-bit trace ids as 32 lowercase hex).
The root's span id is also derived from the seed (the first 64 bits, top bit cleared, as a decimal string, which is the form Datadog wants).
So a child or score emitted after an app restart, for a session whose root went out in an earlier run, parents to that real root: unlike OTLP there is no synthetic parent.
A score for a session that never had a root sent (for example one from before the provider was enabled) joins nothing in Datadog.

**Evaluation timestamps.** The intake rejects a whole request (`HTTP 400 · evaluation metric is a duplicate`) when two evaluations share trace, span, label and millisecond timestamp.
A case close emits one `asset.contribution` score per judged asset in the same millisecond, so the adapter moves each later same-label score on a trace to the next free millisecond.

**Re-emitted scores.** The Evaluations API has no upsert by client id, so an override or a redistill adds a new evaluation.
As with OTLP, deduplicate on the `argus.score.id` tag (latest wins).

**Test connection.** `GET https://api.<site>/api/v1/validate` with the key.
It writes nothing into LLM Observability and fails on a bad key and on the wrong site (a key is only valid on its own site); success reads `authenticated · <site>`.

## Org policy

An organization can enable and configure observability for every engineer with a machine-level policy file that the user cannot change from Argus.
Today it can manage the Datadog provider.

**Location.** macOS `/Library/Application Support/Argus/policy.json`, Windows `%ProgramData%\Argus\policy.json` (Linux `/etc/argus/policy.json`).
The environment variable `ARGUS_POLICY_FILE` overrides the path (tests and gates).
Deliver it with MDM (Jamf, Intune) or another admin-only channel; it lives outside `ARGUS_HOME` so it is not part of the user's data.
No file means no policy, which is the default.

**Schema.**

```json
{
  "observability": {
    "providers": {
      "datadog": {
        "enabled": true,
        "site": "datadoghq.com",
        "mlApp": "argus",
        "env": "prod",
        "captureContent": false,
        "apiKey": "<dedicated Datadog API key>",
        "intakeUrl": "<optional: replaces https://api.<site>>",
        "identifyUser": false
      }
    }
  }
}
```

Every key is optional; `enabled` defaults to `true` (a block exists to turn the provider on), `identifyUser` to `false`.
Validation is strict: an unknown key is an error, so a typo never silently does nothing.

**What it does.**

- The effective configuration is the user's settings with the policy block laid over them; policy keys always win.
  Keys the policy does not set (for example `env` above, if left out) stay the user's.
- `apiKey` is resolved before the encrypted secret store and never touches `settings.json`, the secret store, or the renderer.
- `intakeUrl` replaces `https://api.<site>` for both intake endpoints and the probe.
- `identifyUser: true` adds an `argus.user:<GitHub login>` tag (from `gh api user`) to everything sent. Leave it off unless your organization has decided to attribute telemetry to people.

**Locking.** Settings → Observability shows a managed provider with a **Managed by your organization** badge and a line saying what is sent; the Enable switch and every field the policy sets are read-only.
**Test connection** stays available.
The main process refuses a settings write or a secret write/delete for a managed key too, so a stale window or a direct IPC call cannot change it either.

**Rotation and removal.** The file is re-read when it changes (polled every 2 s), so IT can rotate the key, change a value, or delete the file without users restarting Argus.
Deleting the file returns the provider to the user's own settings (off unless they enabled it).

**Errors fail closed.** An unreadable file, invalid JSON or an invalid block never crashes Argus: an invalid provider block locks that provider **off**, and a `policy` health row (Settings → Health) reports the parse error.
A valid policy shows that row as ok with the path and what it manages.

**Know what this protects.** In this phase the API key sits in plaintext in the policy file on each laptop.
It is not in any downloadable Argus artifact, and IT can rotate it without a release, but anyone with read access to the file can read the key.
Use a dedicated key with a usage monitor.
A later phase replaces it with a relay that holds the key server-side and authenticates Argus with the user's GitHub token; the adapter already takes `intakeUrl` for that.

## Adding a provider

1. Add the id to `ObservabilityProviderId` / `OBSERVABILITY_PROVIDER_IDS` and a descriptor (label,
   description, `fields`: text, select or secret) in `app/src/shared/observabilityProviders.ts`,
   and a settings block under `observability.providers` in `app/src/shared/settings.ts`.
2. Create `app/src/main/services/observability/providers/<id>/index.ts` exporting an
   `ObservabilityProvider { descriptor, missing, createSink, probe }` (see `providers/types.ts`):
   `missing` names the first absent required field or secret, `createSink` returns an
   `ObservationSink` (or `null` when incomplete) honouring `ctx.captureContent`, and `probe`
   backs **Test connection**.
3. Register it in `OBSERVABILITY_PROVIDERS` in `providers/index.ts` — the record type makes a
   missing registration a compile error.
4. Add a contract test that calls `describeSinkContract(label, make)` from
   `providers/__tests__/sinkContract.ts` with a fake backend. It checks that a seed gets exactly one root with its children and scores
   attached (including a score whose root does not exist), that `emit` never throws and a failing
   backend is reported through `lastError()`, that content is sent only when `captureContent` is on,
   and that `shutdown` is idempotent and stops further export.

The settings page and health rows are generated from the descriptor and the registry, so neither
needs a change.

## Testing

- `npm run gate:observability-otlp` (from `app/`) — credential-free. It starts a local OTLP/JSON
  receiver (`app/scripts/lib/otlpReceiver.mjs`), boots the app with a fake distill runner and the
  OTLP provider pointed at it, and asserts that `asset.contribution` evaluation events arrive and
  that no content leaves with `captureContent` off. CI runs it.
- `npm run gate:observability-datadog` (from `app/`) — credential-free. It starts a local fake
  of the Datadog intake (`app/scripts/lib/datadogReceiver.mjs`) and boots the app with
  `ARGUS_POLICY_FILE` pointing at a policy that enables Datadog with `intakeUrl` aimed at the
  receiver. It asserts the locked Settings section, that main refuses locked writes, the validate
  probe, the `asset_contribution` evaluations and distill spans on the wire, no content with
  `captureContent` off, key rotation without a restart, and that deleting the policy turns
  export off. CI runs it.
- Adapter contract suites: `providers/langfuse/__tests__/sink.contract.test.ts`,
  `providers/otlp/__tests__/sink.contract.test.ts` and
  `providers/datadog/__tests__/sink.contract.test.ts`.
- `app/src/main/services/__tests__/policy.test.ts` — the policy file: missing / valid / invalid,
  the env override, hot reload, policy over user settings, the policy key over the secret store,
  and locked writes.
- `app/src/main/services/observability/__tests__/buildExporter.test.ts` — none / incomplete /
  one / several providers, fan-out wiring, a throwing factory, the probe-plus-last-error merge,
  and the health-check order (build error → missing field → probe).

To inspect the wire format by hand, run the receiver from `app/scripts/lib/otlpReceiver.mjs`,
set the OTLP provider's endpoint to it with protocol `http/json`, and use **Test connection**.
