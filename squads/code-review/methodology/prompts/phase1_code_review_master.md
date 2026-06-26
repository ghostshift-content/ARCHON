# Phase 1 Master Prompt — Code Review / Feature Mapping

## Mission

Perform Phase 1 code review and feature mapping.

Phase 1 is not vulnerability hunting.

Phase 1 must create structured evidence that Phase 2 can use for vulnerability assessment.

## Target Output

Create a `phase1-maps/` directory containing:

```text
phase1-maps/
├── README.md
├── inventories/
│   ├── 00_MANIFEST.md
│   └── source inventory files
├── features/
│   └── <feature-slug>.md
└── consolidated/
    ├── 00_INDEX.md
    ├── feature_coverage_matrix.md
    ├── source_inventory_coverage_matrix.md
    ├── same_functionality_cross_feature_map.md
    ├── phase2_review_queue.md
    └── phase1_completion_gate.md
```

## Phase 1 Scope

Phase 1 must map:

- Web routes/controllers/views
- REST/Grape APIs
- GraphQL queries/mutations/resolvers/types
- workers and async jobs
- services
- finders
- models
- policies and abilities
- serializers/entities/presenters
- downloads/exports/generated resources
- search/count/aggregate paths
- token/actor paths
- same-functionality implementations
- shared infrastructure
- gaps and unresolved areas

## Hard Rule

Do not report vulnerabilities as confirmed findings in Phase 1.

Instead, record:

- security-sensitive areas
- suspicious code paths
- Phase 2 leads
- unresolved gaps
- assumptions
- required follow-up

## Required Per-Feature Section Order

Every `features/<slug>.md` must use exactly this section order:

```markdown
# Phase 1 Feature Map: <Feature Name>

## Feature Identity

## Feature Purpose

## Entry Points

### Web Routes / Controllers

### REST API

### GraphQL

### Workers / Async

### Other Entry Points

## Files Reviewed

## Endpoint / Action Ledger

## Full Code Paths

## Authorization Map

## Authentication / Actor Context Map

## Data Exposure Map

## Background Job Map

## Same-Functionality Map

## Security-Sensitive Areas for Phase 2 (ranked)

## Coverage Notes
```

## Depth Status

Use these exact statuses:

| Status | Meaning | Phase 2 Can Rely On It? |
|---|---|---|
| Discovered | Found but not traced | No |
| Mapped | Located in inventory/source | No |
| Traced | Code path partly traced | Partial |
| AuthZ Verified | Authorization verified for the specific object/path | Yes, but Phase 2 must still re-check |
| Deep Complete | Full source path reviewed with low residual uncertainty | Yes, but Phase 2 must still re-check for vulnerability patterns |

## Endpoint / Action Ledger Rule

Every route/method/action/mutation/worker must get its own row.

Do not merge GET/POST/PUT/DELETE into one row.

Do not say “CRUD reviewed” without separate rows.

Use this table:

| Entry Point | Method/Trigger | File | Class/Method | Object Lookup | Auth Check | Object Authorized | Response/State Change | Serializer/Worker | Same-Functionality Siblings | Phase1 Status | Phase2 Priority | Gaps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Files Reviewed Rule

Every relevant file must be listed.

| File Path | Type | Role | Important Methods | Notes |
|---|---|---|---|---|

## Security-Sensitive Areas Rule

Rank security-sensitive Phase 2 leads.

Each lead must include:

- exact file/method/route
- why it matters
- what Phase 2 must verify
- what pattern class it likely belongs to
- whether it affects Web/REST/GraphQL/worker/same-functionality surfaces

## Coverage Notes Rule

Coverage notes must be honest.

Include:

- fully mapped / AuthZ verified areas
- mapped but not deeply verified areas
- assumptions
- required follow-up
- unmapped files
- unresolved blockers

## Phase 1 Completion Rule

Phase 1 completion requires evidence, not confidence.

If inventory reconciliation is incomplete, say so.

If a feature has unresolved mapped/traced/gap rows, say so.

Phase 1 can be substantially complete but still have blockers.
