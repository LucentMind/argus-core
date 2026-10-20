# The HiveMind repository

**HiveMind** is Argus's shared tier: a plain git repository your team owns, holding skills and
reference documents that every Argus install can sync down and share back up. This document
describes the layout Argus expects and how to stand one up.

The repo is identified by `hivemind.repo` in settings — a GitHub `org/name` shorthand, a full clone
URL, or a local filesystem path. An empty string keeps every HiveMind feature dormant.

---

## 1. Expected structure

Argus reads exactly two top-level directories. Everything else in the repo (README, CI config,
CODEOWNERS, …) is ignored and safe to keep.

```
<hive-repo>/
├── skills/
│   ├── incident-triage/
│   │   ├── SKILL.md          ← required; a directory without it is ignored
│   │   ├── reference.md      ← optional extra files, copied wholesale
│   │   └── scripts/probe.sh  ← optional executables (flagged on share and at run time)
│   └── rca-writeup/
│       └── SKILL.md
└── references/
    ├── jira-conventions.md   ← flat .md files
    ├── service-map.md
    └── confluence/           ← the one recognised subfolder
        └── runbook-abc.md
```

### skills/

- One directory per skill. `skills/<name>/SKILL.md` is **mandatory** — a directory without it is
  skipped silently, not reported as broken.
- `name`, `description` and `author` are read from that file's frontmatter.
- The whole directory is copied on install, so scripts, templates and binary assets travel with the
  skill. Executable siblings (by extension, or by a `#!` shebang) are named explicitly in the share
  confirmation and gated at run time — sharing a script is a different act from sharing prose.

### references/

- Scanned **non-recursively**: flat `*.md` files at the top level, plus the specifically-named
  `confluence/` subfolder. Any other subfolder is invisible. This is deliberate, not an oversight.
- Files beginning with `.` are skipped.
- Installs **flatten** to the bare basename, so `confluence/foo.md` and `foo.md` would collide
  locally. Keep basenames unique across both locations.

### Trust tiers

On install, a reference under `references/confluence/` is stamped `trust_tier: confluence`;
everything else in the repo is stamped `hivemind`. An asset already carrying a pushable tier keeps
the tier it has.

---

## 2. Setting one up

**Create the repo and seed the layout.**

```bash
gh repo create my-org/argus-hive --private --clone
```

```bash
mkdir -p skills references/confluence && printf '# Argus HiveMind\n' > README.md && git add -A && git commit -m "init hive layout" && git push
```

Empty directories do not survive a git commit. Commit at least one real
`skills/<name>/SKILL.md` or `references/*.md` — or just the README, since Argus tolerates a missing
`skills/` or `references/` directory and simply lists nothing from it.

**Point Argus at it.** Settings → Team → HiveMind repo, set to `my-org/argus-hive`. A full URL or a
local path works too, which is the usual way to exercise HiveMind offline.

**Sync.** Argus clones the repo and installs from it into your Argus home:

| Path | Contents |
| --- | --- |
| `<ARGUS_HOME>/hivemind` | the managed clone |
| `<ARGUS_HOME>/skills-hivemind` | installed hive skills |
| `<ARGUS_HOME>/config/hivemind-state.json` | per-item commit pins and declined items |

Changing the repo setting discards the clone and re-clones from scratch, so pins never carry across
two different hives.

---

## 3. Prerequisites

Read-only sync needs nothing but `git`.

Sharing back (the push direction) additionally needs:

- **`gh` authenticated** — pull requests are created through the GitHub CLI.
- **`origin/HEAD` resolvable** in the clone. If `git rev-parse --abbrev-ref origin/HEAD` fails, set
  the repository's default branch on the remote, or run `git remote set-head origin -a`.

A share writes the asset back to the same `skills/<name>/` or `references/<name>` path on a branch
named `argus/share-<kind>-<name>-<timestamp>` and opens a pull request against the default branch.
It never force-pushes, and it refuses to push onto a branch a teammate opened for the same asset.
