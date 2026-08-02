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

Your working directory is the case dir, not the repo, so point git at the repo
explicitly: `git -C <linked repo path> …`, or `cd <linked repo path> && …`. Only linked
workspaces and case worktrees are reachable — `cd` anywhere else is denied outright
(a tool error, not an approval prompt).

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
- **Strongest signal for code that is present:** `git blame -L <start>,<end> <file>` on
  the failing lines — the commit that introduced the exact line beats any date window.
- **When the regression is a removal, blame cannot see it.** A deleted guard, a dropped
  `await`, a removed case arm: blame credits whoever wrote the surviving line, which is
  usually the original author and the wrong answer. Use the pickaxe instead —
  `git log -S'<text that used to be there>' -- <path>` finds the commit that deleted it,
  and `git log -G'<regex>' -- <path>` when you only know the shape. Reach for this
  whenever the symptom is "something that used to be checked no longer is."
- **Refiners, when available:** a last-good ref or tag → `git log <lastGood>..<anchor>`;
  a release date → `--since=<date>`. A report date alone is a ranking signal, not a
  hard cutoff — slow-burn bugs ship long before they fire.

## Resolving versions and releases

**If `.claude/references/release-intel.md` exists, read it now — it supersedes
the rest of this section** with organization-specific instructions (release plans,
build↔commit mapping, version lookup). That junction points at the shared references
dir, so it resolves from any case dir. Generic fallbacks otherwise:

- Repo tags: list them with
  `git log --tags --decorate-refs=refs/tags --simplify-by-decoration --date=short --pretty='%h %ad %d'`,
  and name the first tag containing a commit with `git describe --contains <sha>`. Do
  **not** use `git tag` — it is not on the read allowlist (the same command also creates
  and deletes tags), so it forces an approval prompt and, because one segment gates the
  whole `&&` chain, stalls every other read in the same call.
- Version strings in evidence: crash dumps, log headers, build ids — find them with
  `mcp__argus__search_evidence` or `mcp__argus__grep_lines`, then match against tags or
  version-bump commits. Do **not** run raw `grep`/`cat`/`head` against `evidence/` —
  those are gated behind an approval prompt for evidence paths, and gate the whole
  `&&` chain with them.
- Last resort: map the report timestamp to commit dates and treat it as a soft
  bound, stated as such.

## 4 — Rank

Order candidates: pickaxe hit on removed code (when the symptom is a removal) or
blame hit on the failing lines (when it is not) > touched the failing file > touched
the subsystem. Weight by recency and by semantic plausibility against the symptom.
Cap at 3–5 candidates — more is a log dump, not localization.

A blame hit is evidence about a line, not a verdict about a defect. If the diff you
read in step 6 shows the blamed commit made the line _safe_ and something later took
the safety away, the later commit is the suspect and the blamed one is at most a
low-confidence mention.

## 5 — Attribute

Author and date from `git log`. PR number: `gh pr list --search "<sha>" --state merged`
when `gh` is available; otherwise parse merge-commit subjects (`Merge pull request #N`).

## 6 — Verify before asserting

Read each candidate's actual diff (`git show <sha> -- <paths>`) and state why it
plausibly causes the symptom. Never emit a candidate whose diff you did not read.
If no candidate survives, record that honestly, with what was searched and how the
window was bounded.

## Output

Findings are immutable once recorded, so put this section _inside_ the RCA finding when
you call `mcp__argus__append_finding`. If the RCA is already filed (you were asked "what
changed?" after the fact), record a **separate** finding titled `Regression localized: …`
carrying this section, and cross-reference the RCA — never re-file the whole RCA to
attach it.

The shape below is a parse contract. Keep the three field lines verbatim, one candidate
per bullet, and use no parentheses or semicolons inside the anchor and window values:

```
### Suspect commits

anchor: <full-40-char-sha> on <branch>
window: <how it was bounded>

- <short-sha> "<subject>" — <author>, <date> — PR: #N | none | unknown — confidence: high|med|low — <one-line rationale>
```

`PR: none` means you established there is no PR (linear history, no remote); `PR: unknown`
means you could not check. Any caveat about the anchor — for instance that the repo tip is
ahead of the failing build — goes in the prose above the section, not inside these fields.

Cite code as usual (`[<repo-name>/<path>:<line>]`) where a candidate's change is
discussed. For multi-repo cases, run the method per linked repo that has implicated
paths and keep per-repo subsections.

## Red flags

- A suspect named without its diff read.
- A window bounded by a guessed date when blame or the pickaxe was available.
- Naming the blamed author of a line that a _later_ commit made unsafe.
- Anchor unstated, or silently assumed to equal the build that failed.
- More than 5 candidates.
- Treating this section as the RCA — suspect commits supplement the causal chain,
  they do not replace it.
