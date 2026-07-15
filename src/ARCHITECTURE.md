# ARCHON — Clean Architecture Layer (additive)

> Status: **scaffolding, additive-first.** These folders wrap and normalize the current engine
> (`event-bus.js`, `src/dispatch/*`, `src/pipeline/*`) via clean contracts. Existing code stays where it
> is and keeps working; new modules bridge old behavior into new contracts. **Migrate one subsystem at a
> time** (see the Migration Plan). Nothing here replaces working code until its bridge is proven and tests
> + live scans pass.

## The runtime model (target)
```
Mission Lead (CURATOR) → Shared Task Board → Controlled Project Sessions → Specialist Teammates
  → Evidence Store → Streaming Triage → Judge → Report → UI Timeline
```
One scan = one mission = one project understanding (shared blueprint + task board). Agents claim work from
the board, emit evidence + candidates live, triage validates live, judge gates the report.

## Layer map (`src/`)
| Folder | Purpose |
|---|---|
| `runtime/` | mission execution: task board, session planner, quota governor, event emit |
| `agents/` | agent registry + role mapping (existing names → clean roles) |
| `personas/` | built-in + custom personas (planning/priority/evidence-strictness/report-style) |
| `patterns/` | built-in + custom vulnerability patterns (drop-in, centralized) |
| `workflows/` | black-box / static / white-box workflow definitions |
| `knowledge/` | knowledge graph, coverage, correlation, dedupe |
| `evidence/` | source/runtime evidence contracts |
| `findings/` | candidate / validated / judged finding schemas |
| `compatibility/` | bridges to the current event-bus + dispatchers |

## Non-negotiable rules
1. Do not rewrite from scratch. 2. Do not move existing files first. 3. Do not rename existing agents first.
4. Do not break current black-box/static/white-box behavior. 5. Do not remove existing JSONL outputs.
6. Do not remove existing event-bus behavior. 7. Add beside, don't replace. 8. Bridge old → new contracts.
9. Migrate one subsystem at a time. 10. Every milestone independently runnable. **Additive first, replacement later.**

## Schemas
JSON Schemas for the new artifacts live in `common/schemas/` alongside the existing
`pattern_catalog.schema.json`: `task-board`, `session-plan`, `decision-log`, `coverage`, plus the v2
`pattern` and `persona` schemas. All new loaders are **fail-soft** (a bad file is logged + skipped, never
crashes a scan) and preserve the **overlay-empty invariant**: with the custom folders empty, behavior is
identical to today.
