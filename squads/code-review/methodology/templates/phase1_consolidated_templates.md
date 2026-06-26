# Phase 1 Consolidated Templates

## `consolidated/00_INDEX.md`

```markdown
# Phase 1 Consolidated Output Index

| # | Required output | Where it lives |
|---|---|---|
| 1 | Application architecture overview | README + per-feature Feature Identity |
| 2 | Feature coverage matrix | feature_coverage_matrix.md |
| 3 | File-to-feature map | per-feature Files Reviewed |
| 4 | Entry-point-to-feature map | per-feature Entry Points |
| 5 | Authorization map | per-feature Authorization Map |
| 6 | Authentication/actor map | per-feature Actor Context Map |
| 7 | API map | inventories + per-feature REST tables |
| 8 | GraphQL map | inventories + per-feature GraphQL tables |
| 9 | Worker/background job map | inventories + Background Job Map |
| 10 | Serializer/entity/presenter map | inventories + Data Exposure Map |
| 11 | Search/export/download map | inventories + Data Exposure Map |
| 12 | Token flow map | inventories + Actor Context Map |
| 13 | Same-functionality cross-feature map | same_functionality_cross_feature_map.md |
| 14 | Shared infrastructure map | same_functionality_cross_feature_map.md |
| 15 | Unmapped files/directories | phase1_completion_gate.md + coverage notes |
| 16 | Phase 2 review queue | phase2_review_queue.md |
| 17 | Source inventory coverage matrix | source_inventory_coverage_matrix.md |
| 18 | Endpoint/action ledger | per-feature ledger rows |
```

## `consolidated/feature_coverage_matrix.md`

```markdown
# Phase 1 — Feature Coverage Matrix

| # | Feature | Core Files | Entry Pts | Svc/Model/Policy | Workers | Serializers/GraphQL | Same-Func | Ledger Rows | Coverage | Phase 2 Pri | Top Gap |
|---|---|---|---|---|---|---|---|---:|---|---|---|
| TBD | TBD | Y/N | Y/N | Y/N | Y/N | Y/N | Y/N | TBD | Complete/Partial | High/Medium/Low | TBD |
```

## `consolidated/source_inventory_coverage_matrix.md`

```markdown
# Source Inventory Coverage Matrix

| Inventory | Total Items | Reconciled item-by-item | Covered by feature ledger | Coverage basis | Status |
|---|---:|---|---|---|---|
| Rails routes | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| REST API / Grape | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| GraphQL | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| Workers | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| Services/Finders/Policies | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| Serializers/Entities/Presenters | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| Downloads/Exports | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| Search/Count/Aggregate | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
| Tokens/Actors | TBD | Yes/No | TBD | TBD | Complete/Partial/Gap |
```

## `consolidated/phase2_review_queue.md`

```markdown
# Phase 2 Review Queue

## Recurring Vulnerability Patterns

| Pattern Class | Description | Features / Files | Why Phase 2 Should Review |
|---|---|---|---|
| TBD | TBD | TBD | TBD |

## Ranked Single-Target Leads

| Rank | Feature | Lead | File / Method | Pattern Class | Why High Risk | Required Phase 2 Verification |
|---:|---|---|---|---|---|---|
| 1 | TBD | TBD | TBD | TBD | TBD | TBD |
```

## `consolidated/phase1_completion_gate.md`

```markdown
# Phase 1 Completion Gate — Honest Verdict

## Verdict

Complete / Substantially complete with blockers / Incomplete

## Gate Checklist

| Requirement | Status | Evidence |
|---|---|---|
| Every feature has a Phase 1 feature map | Met/Partial/Fail | TBD |
| Every feature has files mapped | Met/Partial/Fail | TBD |
| Every feature has entry points mapped | Met/Partial/Fail | TBD |
| Every feature has authorization points mapped | Met/Partial/Fail | TBD |
| Every feature has same-functionality mapped | Met/Partial/Fail | TBD |
| Endpoint/action ledger per route/method/mutation/worker | Met/Partial/Fail | TBD |
| Every inventory item reconciled | Met/Partial/Fail | TBD |
| Shared service/finder/serializer caller coverage | Met/Partial/Fail | TBD |

## Carried-Forward Blockers

- TBD

## Recommended Next Steps

- TBD
```
