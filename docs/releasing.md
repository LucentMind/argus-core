# Releasing Argus

## The one thing that trips everyone up

`.github/workflows/build.yml` creates a **draft** release, and **electron-updater ignores
drafts**. Until a human clicks Publish, no installed copy of Argus can see the new version.
Publishing the draft *is* the act of making an update available.

## Steps

1. Bump `version` in `app/package.json`. It must match the tag you are about to push.
2. Commit the bump, then tag and push:

       git tag v1.1.0
       git push origin v1.1.0

3. `build.yml` builds Windows and macOS-arm64, signs and notarizes the mac bundle, staples the
   DMG, and creates a **draft** release carrying `.exe`, `.dmg`, `.zip`, `.blockmap` and
   `latest*.yml`.
4. Check the run is green, then **publish the draft release**.
5. Installed copies see the update at their next launch (a boot check) or when the user clicks
   *Check for updates* in Settings → General.

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
