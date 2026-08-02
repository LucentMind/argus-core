---
name: suspect-commits
description: Use when a triaged defect looks like a regression and code paths are implicated — localizes the introducing change by walking git history over the implicated paths from a stated anchor commit, ranking candidates, and recording them with author and PR in the RCA finding. Prevents "what changed" guesses whose diffs were never read.
roles: triage
---

# Suspect Commits

Turn "the null check is missing" into "introduced by commit X in PR Y, owner Z."
Every candidate you emit must have had its diff read. An honest "history does not
localize this" beats a confabulated suspect.

## 1 — Anchor

State the commit the failure is observed on before walking anything:

- A case worktree is materialized → its checked-out ref (`git rev-parse HEAD` there).
- Otherwise → the linked repo's current branch tip.
- Evidence names a specific build/version → resolve it to a ref first (see
  "Resolving versions and releases") and anchor there instead.

Always name the anchor SHA and branch in the output. The linked checkout may not be
the build the user saw fail — a wrong anchor must be visible, never silent.

## 2 — Implicated paths

Collect from the RCA in progress: files cited in findings, stack-trace frames, the
specific failing lines. If a code graph is available (code-graph skill), widen to
the subsystem with `graphify affected <node-id> --depth 2`. No implicated paths
yet → this skill is premature; localize in the codebase first, then come back to
localize in history.

## 3 — Window (layered)

- **Spine, always available:** `git log --date=short --pretty='%h %ad %an %s' -- <paths>`
  walking back from the anchor. Use `--follow` only when querying a single path —
  git silently ignores it with several.
- **Strongest signal:** `git blame -L <start>,<end> <file>` on the failing lines —
  the commit that introduced the exact line beats any date window.
- **Refiners, when available:** a last-good ref or tag → `git log <lastGood>..<anchor>`;
  a release date → `--since=<date>`. A report date alone is a ranking signal, not a
  hard cutoff — slow-burn bugs ship long before they fire.

## Resolving versions and releases

**If `<ARGUS_HOME>/references/release-intel.md` exists, read it now — it supersedes
the rest of this section** with organization-specific instructions (release plans,
build↔commit mapping, version lookup). Generic fallbacks otherwise:

- Repo tags: `git tag --sort=-creatordate`, `git describe --contains <sha>`.
- Version strings in evidence: crash dumps, log headers, build ids — grep the
  evidence, then match against tags or version-bump commits.
- Last resort: map the report timestamp to commit dates and treat it as a soft
  bound, stated as such.

## 4 — Rank

Order candidates: blame-hit on the failing lines > touched the failing file >
touched the subsystem. Weight by recency and by semantic plausibility against the
symptom. Cap at 3–5 candidates — more is a log dump, not localization.

## 5 — Attribute

Author and date from `git log`. PR number: `gh pr list --search "<sha>" --state merged`
when `gh` is available; otherwise parse merge-commit subjects (`Merge pull request #N`).

## 6 — Verify before asserting

Read each candidate's actual diff (`git show <sha> -- <paths>`) and state why it
plausibly causes the symptom. Never emit a candidate whose diff you did not read.
If no candidate survives, record that honestly, with what was searched and how the
window was bounded.

## Output

Append to the RCA finding (`mcp__argus__append_finding`) a section in exactly this
shape — the line format is a parse contract, keep it:

```
### Suspect commits

(anchor: <sha> on <branch>; window: <how it was bounded>)

- <short-sha> "<subject>" — <author>, <date>[, PR #N] — confidence: high|med|low — <one-line rationale>
```

Cite code as usual (`[<repo-name>/<path>:<line>]`) where a candidate's change is
discussed. For multi-repo cases, run the method per linked repo that has implicated
paths and keep per-repo subsections.

## Red flags

- A suspect named without its diff read.
- A window bounded by a guessed date when blame on the failing line was available.
- Anchor unstated, or silently assumed to equal the build that failed.
- More than 5 candidates.
- Treating this section as the RCA — suspect commits supplement the causal chain,
  they do not replace it.
