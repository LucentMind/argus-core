---
name: systematic-triage
description: Use when triaging any defect case toward a root cause — structures the investigation into evidence intake, pattern comparison, hypothesis testing, and a defensible RCA conclusion. Prevents symptom-level verdicts and evidence-free guessing. Adapted for evidence-based triage from systematic-debugging practice.
roles: triage
---

# Systematic Triage

Reach a root cause the defensible way: evidence first, one hypothesis at a time, no verdict
without a traced causal chain. A symptom-level verdict ("the crash is in X") that later
proves wrong costs more than a slower, traced conclusion.

**The rule: no root-cause verdict without completing evidence intake first.**

## Phase 1 — Evidence intake

Before forming any theory:

1. **Read error output completely.** Full stack traces, line numbers, error codes,
   surrounding log lines. The exact answer is often already in the evidence dir.
2. **Establish reproduction.** From the evidence, determine: is it deterministic,
   intermittent, or one-shot? If the case doesn't say, record that as an open question —
   an unreproduced defect caps how confident any conclusion can be.
3. **Check what changed.** Recent commits in linked workspaces, dependency bumps, config
   or environment differences between failing and working. Use `search_case_history` —
   a closed case may already name this root cause. If the symptom looks like a
   regression (worked before, started at some point), note it now: once code paths are
   implicated, use the suspect-commits skill to localize the introducing commit and PR.
4. **Localize across component boundaries.** For multi-component failures (client →
   service → store; build → sign → publish), determine from the evidence which boundary
   the bad data or state first crosses. If the evidence cannot localize it, say which
   boundary is undetermined and what log or capture would decide it — do not pick a
   component by intuition.

## Phase 2 — Pattern comparison

- Find a working analog: an earlier build, a passing environment, a sibling component,
  a similar closed case.
- Enumerate every difference between working and broken — config, versions, inputs,
  timing. Do not discard a difference as "can't matter" without a cited reason.
- If implementing-against-a-reference is involved, read the reference completely before
  judging the divergence.

## Phase 3 — Hypothesis testing

- **One hypothesis at a time**, stated explicitly: "X is the root cause because Y."
- Test it minimally against evidence: one prediction the hypothesis makes that the
  evidence (or a small experiment in a case worktree) can confirm or refute.
- Refuted → form a new hypothesis; never stack a second theory on top of an untested one.
- **Two refuted hypotheses → stop narrowing.** Re-examine which component you assume is at
  fault; the frame, not the detail, is usually what's wrong. Widen the search and tell the
  user you are doing so.

## Phase 4 — Conclusion (the RCA finding)

Record the conclusion with `mcp__argus__append_finding`, containing:

- **Causal chain**: symptom → proximate cause(s) → original trigger, one citation per hop
  (`[<rel-path>:<line>]` for evidence, `[<repo-name>/<path>:<line>]` for code). A chain
  that stops at a proximate cause must say so and say why. When the original trigger is
  a code change, name the introducing commit/PR (suspect-commits skill).
- **Confidence label**: CONFIRMED (every hop cited) or HYPOTHESIS (plausible, with the
  specific evidence that would confirm it).
- **Minimal reproduction recipe**, when derivable: the smallest input/steps that trigger
  the defect — this is what makes the finding actionable for whoever fixes it.
- **Recommended fix direction**: fix at the original trigger, not the symptom; optionally
  note validation layers between trigger and symptom that would have contained it.

You analyze; you do not fix. Code changes happen only if the user accepts a finding and
explicitly asks.

## Honest dead ends

If the evidence genuinely cannot decide (environmental, timing-dependent, missing data):

1. Record what was investigated and which hypotheses were refuted, with citations.
2. Classify the residual uncertainty (environment, timing, external dependency).
3. Recommend the specific data, log, or instrumentation that would decide it next time.

Ending with "undetermined — here is what would determine it" is a valid triage outcome.
Ending with an uncited guess is not. Most "no root cause" cases are incomplete intake —
re-check Phase 1 before declaring one.

## Red flags — stop and return to Phase 1

- "It's probably X" before the evidence is read end-to-end.
- A verdict that names a component no citation points at.
- Two theories alive at once, neither tested.
- Explaining away a difference between working and broken without evidence.
- Declaring the proximate cause to be the root cause because tracing further is hard.
