# src/knowledge — graph, coverage, correlation, dedupe

The shared understanding layer: the knowledge graph, coverage accounting, source↔runtime correlation, and a
unified dedupe key. Wraps the existing `src/intel/knowledge-graph.js`, `src/pipeline/cross-view-dedup.js`,
`src/pipeline/suspected-dedup.js`, and `src/dispatch/whitebox-correlation.js` behind clean contracts.

Planned:
- `coverage.js` — writes `var/intel/coverage-<taskId>.json` (schema: `common/schemas/coverage.schema.json`)
- `correlation.js` — source↔runtime linking (bridges `whitebox-correlation.js`)
- `dedupe.js` — one canonical key across `suspected-dedup` / `cross-view-dedup`

Milestones: coverage artifact M5–M7 (observe-only) · correlation/dedupe unification later. Additive; existing
dedupe/correlation stays authoritative until bridged.
