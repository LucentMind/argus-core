# Observability

Argus can export what its agent does — traces, cost, latency and a handful of scores — to an
external backend. It is **off by default**: nothing leaves the machine until a provider is enabled
and complete in **Settings → Observability**. Backends are *providers*; two exist today, Langfuse
and OpenTelemetry (OTLP/HTTP), and any number can be on at once.

## What Argus sends

Per agent session, one trace:

| Signal | Name | Notes |
|---|---|---|
| Trace root | `<case slug> · session <id>` | Grouped by case (Langfuse session id / `gen_ai.conversation.id`). A resumed session adds a `session resumed` event to the existing trace. |
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
| Langfuse | Host URL, Public key | `observability/langfuse/secret-key` |
| OpenTelemetry (OTLP/HTTP) | Endpoint, Protocol (`http/protobuf` default, or `http/json`) | `observability/otlp/authorization` (optional) |

Secrets never live in `settings.json`; the stored settings are under
`observability.providers.<id>` (`enabled`, the plain fields, `captureContent`).

A provider is **enabled and complete** when its toggle is on and every required field and secret
is present (Langfuse: host, public key, secret key; OTLP: endpoint). Only such a provider gets a
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
- *Datadog* — Datadog's direct OTLP intake authenticates with a `DD-API-KEY` header, which the
  Authorization field does not set. Point the endpoint at a Datadog Agent with OTLP ingest
  enabled, or at an OpenTelemetry Collector using the Datadog exporter, and let that hold the key.

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
- Adapter contract suites: `providers/langfuse/__tests__/sink.contract.test.ts` and
  `providers/otlp/__tests__/sink.contract.test.ts`.
- `app/src/main/services/observability/__tests__/buildExporter.test.ts` — none / incomplete /
  one / several providers, fan-out wiring, a throwing factory, the probe-plus-last-error merge,
  and the health-check order (build error → missing field → probe).

To inspect the wire format by hand, run the receiver from `app/scripts/lib/otlpReceiver.mjs`,
set the OTLP provider's endpoint to it with protocol `http/json`, and use **Test connection**.
