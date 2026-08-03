# Releasing Argus

## The one thing that trips everyone up

`.github/workflows/build.yml` creates a **published** release, not a draft — pushing a
`vX.Y.Z` tag ships it. There is no human review checkpoint between a green build and
electron-updater offering the new version to every installed copy at its next boot check.
Nothing in this pipeline waits on the separate CI workflow's test suite either, so **make
sure `main` is green before you tag**, not after.

## Steps

1. Bump `version` in `app/package.json` (and the two matching entries in
   `app/package-lock.json`). It must match the tag you are about to push.
2. Add a `## vX.Y.Z — YYYY-MM-DD` section to the top of `CHANGELOG.md` — the release job reads
   this section verbatim for the release notes and fails the job if it's missing.
3. Commit the bump, then tag and push:

       git tag v1.1.0
       git push origin v1.1.0

4. `build.yml` builds Windows and macOS-arm64, signs and notarizes the mac bundle, staples the
   DMG, and creates a **published** release carrying `.exe`, `.dmg`, `.zip`, `.blockmap` and
   `latest*.yml`, with notes pulled from the `CHANGELOG.md` section for that tag.
5. Installed copies see the update at their next launch (a boot check) or when the user clicks
   *Check for updates* in Settings → General — no publish step needed, it's already live.

## Notes

- Prereleases are ignored: `allowPrerelease` is false, so a tag marked prerelease on GitHub will
  not be offered.
- `latest.yml` is what the updater reads. If it is missing from the release assets, the build
  leg that produces it failed and no client will see the update.
- **Windows installers are unsigned.** Auto-update works — electron-updater only enforces
  publisher verification when a `publisherName` is configured — but a downloaded installer can
  trip a SmartScreen "unrecognized app" warning, exactly as manual downloads do today. To fix:
  add `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` to the build workflow mirroring the macOS leg, and
  pin `publisherName` in `electron-builder.yml`.
  With no `publisherName` configured, publisher verification is the one check that's off — the
  only things binding a downloaded installer to Argus are GitHub's TLS and release-write access
  on this repo. That makes release-write access on this repo equivalent to code execution on
  every installed copy of Argus. This is the accepted posture for now, not an oversight; revisit
  it when Windows signing lands.
- macOS updates require the new build to be signed by the same Developer ID team as the
  installed one. `build.yml` already asserts the team identity.
