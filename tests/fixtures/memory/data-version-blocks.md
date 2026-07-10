BLOCKED_VERSION on TileRegionLoadError means the tile server rejected the client's
dataVersion — the version was pulled from the allowlist. Triage order: (1) confirm the
dataVersion string in the Config line, (2) check it against the data-versioning
allowlist, (3) only then look at quota/network. Signature (verbatim):
`MbxTileStore: TileRegionLoadError: BLOCKED_VERSION region install rejected`.
