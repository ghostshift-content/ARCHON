# src/findings — candidate / validated / judged finding schemas

Canonical shapes for a finding as it moves through the pipeline. Wraps `agents/finding-schema.js` and the
existing JSONL artifacts — **it does not replace them**.

Existing artifacts (kept, never removed):
`live-findings-<taskId>.jsonl` · `VALIDATED-FINDINGS-<taskId>.jsonl` · `JUDGED-FINDINGS-<taskId>.jsonl`

Stages:
- **candidate** — streamed live by a specialist (source or runtime); carries `pattern_id`, source/sink, mode,
  `duplicate_key`, `requires_runtime_validation`
- **validated** — survived triage (`SOURCE_CONFIRMED` / `NEEDS_LIVE_VALIDATION` / `RUNTIME_CONFIRMED` / `DISPROVEN`)
- **judged** — passed the judge gate → eligible for the report

Additive: schemas describe the existing records; the current writers stay authoritative.
