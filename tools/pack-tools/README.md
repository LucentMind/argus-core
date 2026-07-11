# @argus/pack-tools

Generic packager for Argus packs. Validates a pack manifest, assembles the bundle
layout, checksums **every** file, and zips it. **It never compiles binaries** — your
pack's CI builds those first and passes their directory via `--bin`.

## CLI

    npm install && npm run build
    node dist/cli.js build --pack ./ --bin ./out/bin --platform mac-arm64 --out ./dist

Produces `dist/<packId>-<version>-<platform>.zip` containing `argus-pack.json`
(with `platform` stamped), `persona.md`, `skills/`, `references/`, `ui/`, `bin/`,
and `CHECKSUMS`.

## GitHub Action

    - uses: <core-repo>/tools/pack-tools@<ref>
      with:
        pack: ./
        bin: ./out/bin
        platform: mac-arm64
        out: ./dist

## Consuming from a separate pack repo

`pack-tools` lives in the Argus **Core** repo and imports Core's manifest schema
(single source of truth). A separate pack repo's CI uses it either via the Action
above (pinned to a Core ref) or by installing this package (git dependency / built
tarball). Full npm-registry publishing is deferred (see the Part 2 spec §11).

## Checksums are corruption detection, not authenticity

`CHECKSUMS` is unsigned; it detects accidental corruption on install, not tampering.
The trust anchor is the trusted vendor plus the file the user downloaded (Part 2 spec §7a).
