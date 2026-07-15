# src/patterns/builtin

New-format built-in pattern packs (one folder per vuln class), layered **on top of** the existing catalog
(`common/patterns/*.json` + the markdown catalogs), which remains the current source of truth and keeps loading
unchanged. This folder is where **shipped** patterns migrate to the v2 format over time — additively, class by
class. Empty is fine: the registry falls back to the legacy catalog.

Pack format: `common/schemas/pattern.schema.json`. A pack file = `{ "class": "<class>", "patterns": [ … ] }`.
Place under `builtin/<class>/<name>.json`.
