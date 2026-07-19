# Langfuse v5 — empirical findings

Captured against `https://cloud.langfuse.com` on 2026-07-19 with `@langfuse/*` 5.9.1
and `@opentelemetry/sdk-trace-node` 2.9.0.

Method: two throwaway spike scripts emitted real traces; the results were read back
through the Langfuse public API (`GET /api/public/traces/{id}`) rather than by eye,
so every claim below is a recorded server response, not a UI impression.

Spike A trace: `ff55bf14151a64d0f0009ddef6a3de05`
Spike B trace: `7d90f387374b05baf0c133fe4fdee74d`

---

## Q1. `costDetails` key name → **`total`**

Spike A emitted both candidates on one generation with distinguishable values:

```js
costDetails: { total: 0.111, totalCost: 0.222 }
```

API read-back:

```
costDetails    : {"total":0.111,"totalCost":0.222}
totalCost      : 0.111
```

Langfuse stores the map verbatim but **interprets `total`** as the cost. Confirmed
independently in spike B, which emitted only `costDetails: { total: 0.01 }` and read
back `totalCost: 0.01`.

**=> Use `costDetails: { total: costUsd }`.**

This is the finding the contract test exists to protect: v3's `totalCost` field is
silently dropped by v5 — unknown keys produce no error, just missing cost data.

## Q2. `usageDetails` → confirmed working

Emitted `{ input: 11, output: 22 }`; read back `{"input":11,"output":22,"total":33}`.
Langfuse derives `total` itself. v3's `usage: { input, output }` is likewise dropped
silently if not renamed.

## Q3. Dangling synthetic parent → **works**

Both spikes created the root observation with a `parentSpanContext` naming a span that
is never emitted. Read-back shows the trace is well-formed: it resolves by id, carries
both observations, and the generation nests correctly under the root
(`parentObsId: f35a5f515bead4f0` = the root's real span id). The root's own
`parentObsId` points at the synthetic id, which no observation claims.

**=> The deterministic seed design holds.** No need for the §9.2 fallback of persisting
`traceId` on the `sessions` row; resumed sessions rejoin their original trace with no
persisted state.

## Q4. Trace naming requires an explicit attribute — **NOT in the original design**

Discovered during the spike; not one of the questions asked.

Spike A named the root *observation* `spike root` and left the trace's own name **empty**
— it appears as a blank row in the traces list. Naming an observation does not name its
trace.

Spike B set the raw OTel attribute on the root span before ending it:

```js
root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, 'auth-bug · session 42')
```

Read-back: `name: auth-bug · session 42`, and the traces list shows it correctly.

`LangfuseOtelSpanAttributes` (from `@langfuse/core`) exposes the trace-level keys:

```
TRACE_NAME       = langfuse.trace.name
TRACE_USER_ID    = user.id
TRACE_SESSION_ID = session.id
TRACE_TAGS       = langfuse.trace.tags
TRACE_PUBLIC     = langfuse.trace.public
TRACE_METADATA   = langfuse.trace.metadata
TRACE_INPUT      = langfuse.trace.input
TRACE_OUTPUT     = langfuse.trace.output
```

**=> The sink must set `TRACE_NAME` (and metadata) on the root span.** Without it every
Argus session appears as an unnamed row, defeating the trace-per-session design.

## Q5. `session.id` populates the Sessions view and groups traces — **acted on**

Spike C emitted two traces, each a separate deterministic seed, both setting the same
value on their root span:

```js
root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, caseSlug)
```

API read-back of `GET /api/public/sessions/spike-case-1`:

```
id     : spike-case-1
traces : [ { name: "spike-case-1 · session 2", sessionId: "spike-case-1" }, ... ]
```

and each trace individually reports `sessionId: "spike-case-1"`, `userId: null`.

**=> Langfuse sessions are populated by a plain root-span attribute.** Argus maps its
**case** (not its session) onto the Langfuse session, so every Argus session for a case
groups under one row. Mapping the Argus *session* would be pointless: one Argus session
is already exactly one trace, so each Langfuse session would contain a single trace.

`userId` is left unset deliberately — Argus is a single-user desktop app, so the Users
view would show one user owning everything. Revisit if several people ever point their
Argus at a shared Langfuse project.

### Incidental observation

Traces carry `metadata.resourceAttributes["service.name"] = "unknown_service:<path to the
node/electron executable>"`, an OpenTelemetry default. Harmless, but it does put a local
filesystem path into trace metadata. Setting a real service name on the tracer provider's
resource would clean it up. Not done here.

### Side note, recorded but not acted on

`TRACE_SESSION_ID = session.id` is settable as a plain span attribute, so the
trace-per-turn model (design option C) was more feasible than the spec concluded — the
spec ruled it out partly because `sessionId` appeared to require the `propagateAttributes`
context manager. The decision to use trace-per-session stands on its own merits (one
click to review a finished session, which is the stated workflow); this note exists so a
future reader knows the constraint was softer than recorded.
