# packs/

Bundled packs that ship with Argus Core. Core itself is domain-free; a pack declares its
own persona, skills, references, binaries, and detectors, and Core discovers them at startup.

## Internal packs vs. user packs

- **Internal packs live here.** These are first-party, generic feature packs maintained by
  and **bundled with** Argus Core (e.g. `code-graph`). They are tracked and published with
  Core.
- **User / public packs do NOT live here.** These are **domain-specific** packs — provided
  by a user or vendor for a particular product or workflow — that live in their **own repos,
  outside this repository**. They are loaded in development via `ARGUS_PACKS_DIR` and
  installed/bundled separately by whoever owns them. A domain pack may be proprietary (built on
  a vendor's confidential systems); such packs must **never** be committed here.

The boundary is a convention first — internal (generic, first-party) packs are bundled; user
(domain-specific, external) packs stay out — with the pre-push guard scanning for known
confidential tokens as a backstop.

## Bundled internal packs

- **`code-graph`** — per-repo tree-sitter code graphs (blast-radius / impact / dependency
  queries) powered by the public [`graphifyy`](https://pypi.org/project/graphifyy/) tool.

## Recognized reference overrides

Core skills consult well-known files in the shared `references/` dir that domain
packs may ship (via their `references/` asset dir; seeding precedence applies):

- **`release-intel.md`** — read by the `suspect-commits` core skill in place of its
  generic version/release fallbacks. Should describe, for your organization: how to
  map a build/version string to a commit or tag, where release plans/dates live, and
  any version-lookup commands the agent may run.
