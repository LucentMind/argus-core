---
name: code-review
description: Use when reviewing a linked pull request's diff — structures the review into an aggressive find pass across four lenses and a strict claim-verification pass before any finding is recorded. Prevents nitpick floods and unverified findings; a clean "no issues" review is a valid outcome.
roles: review
---

# Code Review

Review value is destroyed by false positives: every dismissed comment trains the author to
stop reading. So find aggressively, verify ruthlessly, and record only what survives. A
short review of real issues beats a long one, and "no issues found" is a first-class result.

**The rule: no finding is recorded until its specific claim has survived a refutation
attempt against the actual code.**

## Pass 1 — Find (suspicion is free)

Work the diff through four lenses, in order. Chase every suspicion with tools — search the
repo, read surrounding code, run what you can in the case worktree — rather than judging
from the diff text alone.

1. **Acceptance criteria.** Read the ticket's requirements first. Does the diff implement
   each required behavior? Missing or wrong required behavior is a candidate like any other.
2. **Bug scan.** Read the changed hunks for defects the change introduces: broken logic,
   unhandled edge cases the new code creates, wrong results under specific inputs,
   security-relevant mistakes in the new paths.
3. **History context.** Read `git blame` / `git log` of the touched code. Does the change
   break an invariant the history reveals — a past fix being undone, a comment explaining
   why the old shape was load-bearing, a pattern every prior commit preserved?
4. **Local conventions.** Read the comments and surrounding code of the modified files. Does
   the change violate guidance stated in the code itself or the file's established idiom?

Collect candidates liberally in this pass — the filter comes next, not here.

## Pass 2 — Verify (recording is expensive)

For each candidate, separately:

1. **State the claim precisely**: "under input/state X, the changed code does Y instead of
   Z" — with the exact lines involved.
2. **Try to refute it.** Read the code that would disprove the claim: callers, guards
   upstream, tests that cover the path, the type system. If you can execute the scenario in
   the worktree, do.
3. **Record only survivors** with `mcp__argus__append_finding`:
   - the failure scenario (input/state → wrong outcome);
   - citation(s) into the diff: `[<repo-name>/<repo-relative-path>:<line>]`;
   - label: CONFIRMED (refutation attempted and failed, evidence cited) or PLAUSIBLE
     (could not fully verify — say what would settle it);
   - severity by observable consequence: critical / major / minor;
   - fix direction, one line, when it is not obvious.

Never rate severity or confidence by feel — Pass 2 verifies claims, it does not score
impressions. One finding per unique issue; if the same root mistake surfaces in five
places, that is one finding with five citations.

## Do NOT record

- Pre-existing issues — real, but on lines the PR did not modify (worth one passing
  mention in the summary at most, never a finding).
- Anything a linter, typechecker, compiler, or CI would catch (imports, type errors,
  formatting). Assume those run separately; do not run them as your review.
- Style preferences and pedantic nitpicks a senior engineer would not raise.
- Theoretical risks that require unlikely preconditions, or defense-in-depth suggestions
  where a primary defense already exists.
- Changes in behavior that are clearly intentional parts of the ticket.
- General quality commentary (coverage, docs, architecture taste) not anchored to a
  concrete failure scenario or an acceptance criterion.

If you are not certain an issue is real, do not record it.

## Verdict

End every review with:

- findings ranked most-severe first (or an explicit "no issues found — checked acceptance
  criteria, bugs, history, conventions");
- a verdict: **ready** / **ready with fixes** / **not ready**, with one sentence of
  reasoning tied to the most severe finding or to the criteria all being met.

## Boundaries

- Read-only on every checkout: never mutate the working tree, index, HEAD, or branch state
  of a linked repo. Need another revision? `mcp__argus__workspace_checkout` gives a
  case-scoped worktree.
- You review; you do not fix. Code changes happen only if the user explicitly accepts a
  finding and asks you to apply it.
- If review feedback already exists on the PR, do not repeat points the author has seen —
  add only what is new.
