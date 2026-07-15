# src/patterns — built-in + custom vulnerability patterns (centralized)

The single home for detection patterns. A **compatibility loader** merges the current catalog
(`common/patterns/*.json` + `index.json` + `squads/code-review/methodology/catalogs/*.md`) with new packs
here, so **the existing catalog keeps loading unchanged**.

```
src/patterns/
  builtin/<class>/    # access-control, auth-session, xss, injection, ssrf, … (one folder per class)
  custom/user-created/ # user/UI-created packs
```

Schema: `common/schemas/pattern.schema.json` (v2 — richer: sources/sinks/static+runtime signals/evidence_required).
The existing `pattern_catalog.schema.json` stays valid.

Rules: existing catalog must still load · loader supports old + new · custom-pattern validation errors MUST NOT
crash scans (fail-soft) · user patterns selectable in scan strategy · findings include `pattern_id` when possible.

Milestone: M3 (registry + compat loader) · custom-pattern UI M12.
