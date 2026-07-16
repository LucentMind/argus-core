---
name: contribute-back
description: Use when an investigation produced a reusable lesson worth adding to Argus's skills or references — a repeatable analysis procedure, a glossary/runbook correction, or a proven command recipe. Drafts an inert proposal the user reviews on the Skills page; never applies changes directly.
---

# Contribute Back

Turn what this case taught you into a proposal that improves Argus for every future case.
Proposals are **inert files** — nothing changes until the user accepts them on the Skills
page (Proposals tab). Your job ends when the proposal is drafted.

## When to propose

After an RCA or investigation surfaces something reusable:

| You found | Proposal type | Target |
| --- | --- | --- |
| A repeatable analysis procedure no skill covers | `skill-new` | new skill dir name (kebab-case) |
| An improvement to an existing skill (missing step, wrong assumption, better tool use) | `skill-edit` | that skill's dir name |
| A correction or addition to a reference (glossary, runbook, protocol doc) | `reference-edit` | the reference file name |
| A proven command sequence worth keeping verbatim | `recipe` | short kebab-case name |

**Memory vs proposal:** durable cross-case *facts and lessons* belong in agent memory
(`write_memory`). Reusable *procedures and reference content* belong in proposals. If it
tells a future session what is **true**, it is memory; if it tells a future session what
to **do**, it is a proposal.

## How to propose

1. **Read the current state first.** For `skill-edit` / `reference-edit`, read the existing
   SKILL.md or reference file in your session's skills/references — the tier winner there is
   exactly what the review UI diffs against. A proposal that duplicates or regresses current
   content wastes the user's review time.
2. **Generalize.** Strip case-specific details — no customer names, ticket numbers, secrets,
   or paths from this case. The proposal must make sense in a future, unrelated case.
3. **Call `mcp__argus__write_proposal`** with:
   - `type` — one of the four types above;
   - `target` — skill dir name or reference file name (see table);
   - `title` — one line the user can judge from the Proposals list without opening it;
   - `content` — the **full proposed file content** (frontmatter included for skills),
     never a diff or a fragment.
4. **One proposal per improvement.** Two unrelated lessons = two proposals.

## Boundaries

- NEVER edit `skills/` or `references/` through filesystem tools — proposals are the only
  path, and they are inert until the user accepts them.
- Do not re-draft a proposal the user already rejected in this session.
- After drafting, tell the user what you proposed and why, in one or two lines.
