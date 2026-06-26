# Threat-Model Discipline — Cross-Squad Design (v2)

**Date:** 2026-04-23
**Author:** SANJAY (per Jay's full-autonomy approval)
**Status:** APPROVED design (Option C — layered, unified schema + stacked sub-rule caps)
**Scope:** All 7 squads; repository-agnostic; builds on evidence-completeness v1 (shipped earlier today)
**Relationship to v1:** Extends — does NOT replace. v1's `evidence_completeness` cap continues to apply; v2 adds additional caps that stack (worst cap wins).

---

## 1. Problem Statement

Today's live verification of 13 Critical/High findings against a running GitLab instance (via agent-browser + gitlab-rails runner) revealed **0 findings would be accepted as Critical/High by the target vendor's security team**. At most, 1 might be triaged Medium. Breakdown:

| FP Class | Example from verification | Count |
|---|---|---|
| 1. Local-only evidence inflation | DH-AC-001 controller-inheritance "BFLA" | 4 (all FP) |
| 2. Trust-boundary inflation | VI-AC-001 silent email change (admin-only) | 3 (all real code but over-rated) |
| 3. Toolchain-presence inflation | DR-RC-001 ImageTragick (IM not installed) | 1 (FP) |
| 4. Layer-blind validation gap | VI-AC-004 impersonation scopes (model validates) | 1 (FP) |
| 5. Documented-default inflation | BA-SS-001 allow_local_requests_from_system_hooks | 1 (documented tradeoff) |
| 6. Working-as-designed inflation | VI-AC-002 silent 2FA destroy (rescue feature) | 2 (overlapping with Class 2) |

Class 1 was fixed earlier today by **evidence-completeness v1** (GATE-11, pipeline_trace, local_only cap). Classes 2–6 remain. Root cause across 2–6: **the framework rates findings against theoretical worst-case impact, not realistic attacker model + intentional-design context.**

---

## 2. Goal

Reduce false positives at the Critical/High severity tier by an additional ~80% through **threat-model calibration**. Specifically:

- Admin-only attacks cap at Medium unless they cross a trust boundary.
- Toolchain/binary CVE claims cap at Low unless runtime presence is verified.
- Documented/intended behavior auto-downgrades one tier.
- Validation claims must check every layer (router → middleware → controller → model → db-constraint), not just the controller.

**Success criteria:**
- Re-running today's GitLab code-review with discipline v2 active would emit 0 Critical and at most 1 High finding (VI-AC-003 OAuth identity injection — the only one that plausibly crosses a trust boundary).
- Works for ANY target repo (not GitLab-specific). Applies across all 7 squads with squad-specific provider variants.
- Zero breakage of v1 evidence-completeness tests (existing 47/47 verify gates + 25/25 test files stay green).
- No new top-level directories — extends existing files only.

---

## 3. Architecture — Option C (Layered)

**Unified schema field** (one field per candidate) + **stacked sub-rule caps** (multiple axes composed inside the cap function). Best ergonomics (specialist fills one object) + best composability (each FP class has its own independent rule).

### Layer 1 — Universal meta-discipline: `MUST_GATE-12 [THREAT-MODEL]`

Added to `squad-framework.js` `MUST_GATES` and `MUST_GATES_STOCKS` strings. Auto-injected into every specialist, KRIPA, and VYASA prompt across all 7 squads via existing `getSquadGates(squad)` mechanism.

Gate text (deliberately abstract — each squad has its own trust model semantics):

> **GATE-12 [THREAT-MODEL]** — Before claiming CRITICAL or HIGH severity, state the realistic attacker model as structured metadata on the candidate: what privilege level does the attacker need (unauth / authenticated / privileged / admin / superuser)? What trust boundary (if any) does the attack cross? Are required runtime dependencies (binaries, services, config flags) verified present? Is this behavior documented as intentional by the target? Severity must match the realistic attack path, not worst-case theoretical impact. KRIPA applies stacked caps: admin-only → max Medium; working-as-designed → −1 tier; toolchain not verified → max Low; no trust boundary crossed → −1 tier. Cap composition: worst ceiling among applied rules.

### Layer 2 — Code-review deep provider: `getThreatModelContext(squad, target)`

New function in `feedback-loop.js` alongside existing `getPipelineCompletenessContext`. Gated by new squad-framework flag.

Returns framework-agnostic threat-model discipline text for code-review squad. Example layer taxonomy, cross-platform — works for Rails / Django / Express / Spring / Laravel / Go / .NET / PHP / Ruby / Node. Includes:

- Attacker-privilege levels with cross-framework examples (Rails `current_user.admin?`, Django `is_superuser`, Spring `@PreAuthorize("hasRole('ADMIN')")`, Laravel gates)
- Trust-boundary categories (cross-user IDOR, cross-tenant, privilege-escalation, unauth-to-auth)
- Validation-layer taxonomy (router → middleware → controller → model → db-constraint → framework-default)
- Toolchain-presence verification playbook (check binary `which convert`, gem `Gem.loaded_specs`, config `ApplicationSetting`)
- Intentionality signals (docs, tests named `*_intended_spec.rb`, `# by design` comments, feature flags)

Squad-framework config (extends existing `evidenceCompleteness`):

```javascript
'code-review': {
  ...
  evidenceCompleteness: { enabled: true, provider: 'pipeline' },
  threatModel: { enabled: true, provider: 'threat-model' },
},
'cloud-security': {
  ...
  threatModel: { enabled: false, provider: 'iam-threat-model' },
},
// etc. — same pattern as v1
```

### Layer 3 — Candidate output schema (new field, every squad where threat-model enabled)

Every specialist JSONL candidate MUST include, in addition to v1's `evidence_completeness` + `pipeline_trace`:

```json
{
  "threat_model": {
    "attacker_privilege": "unauth" | "authenticated" | "privileged" | "admin" | "superuser",
    "trust_boundary_crossed": "none" | "cross-user" | "cross-tenant" | "privilege-escalation" | "unauth-to-auth" | "cross-org",
    "prerequisite_actions": ["must obtain admin cookie", "..."],
    "documented_as_intended": false,
    "toolchain_presence_verified": true | false | null,
    "validation_layers_checked": ["router", "middleware", "controller", "model"]
  }
}
```

Semantics of each field:

- `attacker_privilege` — minimum privilege the attacker must already possess to trigger the finding. Pre-existing login ≠ "privileged". "privileged" means in-app role elevation (org-owner, group-maintainer, project-admin). "admin" = instance admin. "superuser" = shell/sudo/sidekiq-worker level.
- `trust_boundary_crossed` — does the attack move the attacker ACROSS a security boundary? `none` = staying within already-granted privilege. `privilege-escalation` = gain new app-level privilege. `cross-user` = affect another user without their consent. `cross-tenant` = affect another org/tenant. `unauth-to-auth` = pre-auth RCE / unauth BFLA. `cross-org` = cross-instance if multi-tenant.
- `prerequisite_actions` — array of human-readable preconditions the attacker must already complete. Helps KRIPA reason about exploitability chain.
- `documented_as_intended` — did the specialist find docs, tests, or `# by design` comments indicating the observed behavior is intentional? true = WONTFIX territory.
- `toolchain_presence_verified` — for findings that claim a specific binary/library/config is exploitable: have you verified that binary/library/config is actually loaded at runtime? true = verified via `which`, `Gem.loaded_specs`, `ApplicationSetting.current`, etc. false = claim based on manifest only. null = finding doesn't depend on a specific toolchain (N/A).
- `validation_layers_checked` — for findings that claim a validation gap: which layers did you inspect? Array from [router, middleware, controller, model, db-constraint, framework-default]. Under 3 entries → capped (same logic as v1 pipeline_trace minimum).

### Layer 4 — KRIPA stacked severity cap

In `evidence-completeness.js`, add `capSeverityByThreatModel(claimed, threatModel)`. Compose with existing `capSeverity(claimed, evidenceCompleteness)` from v1. **KRIPA applies worst (lowest) ceiling of all applicable caps.**

Sub-rule cap table (applied independently; then MIN of ceilings wins):

| Sub-rule | Condition | Severity ceiling effect |
|---|---|---|
| `attacker_privilege` | unauth | No cap (Critical OK) |
|  | authenticated | No cap (Critical OK — genuine BFLA) |
|  | privileged | max High |
|  | admin | max Medium |
|  | superuser | max Low |
| `trust_boundary_crossed` | none | −1 tier from whatever cap |
|  | privilege-escalation / unauth-to-auth / cross-tenant | +1 tier (undo admin cap if applicable) |
|  | cross-user | no adjustment |
| `documented_as_intended` | true | −1 tier |
| `toolchain_presence_verified` | false (when claim depends on toolchain) | max Low + flag |
|  | null | N/A |
|  | true | no cap adjustment |
| `validation_layers_checked` | < 3 layers AND claim is validation gap | treat as `evidence_completeness: partial` → max Medium |

Composition order:
1. Start with specialist-claimed severity.
2. Apply v1's evidence_completeness cap (`full` → no cap, `partial` → max Medium, `local_only` → max Low).
3. Apply attacker_privilege cap.
4. Apply trust_boundary_crossed modifier (+/- tiers; applied to the current running ceiling).
5. Apply documented_as_intended modifier.
6. Apply toolchain_presence_verified cap if applicable.
7. Apply validation_layers_checked cap if applicable.
8. Return the MIN ceiling reached (worst/lowest severity).

### Layer 5 — VYASA report extension

VYASA's Executive Summary tier table already has 4 columns from v1. Add one new dimension row per-finding showing the full threat-model tier tag:

```
Evidence tier: Full-Trace Suspected
Threat tier: Admin-Only / Working-As-Designed / Toolchain-Unverified
Effective severity (after caps): Informational (from Critical)
Downgrade reason: attacker_privilege=admin + documented_as_intended=true → stacked
```

Adds transparency so human reviewers see exactly why a finding was downgraded.

---

## 4. Data Flow

```
[Specialist reads source]
  │
  ▼
[Specialist emits candidate with evidence_completeness + threat_model + pipeline_trace + signatures]
  │
  ▼
[UTTARA runtime validation if deployUrl — unchanged from v1]
  │
  ▼
[KRIPA applies STACKED caps:
   v1 evidence_completeness cap → intermediate ceiling
   v2 threat_model sub-rules → stacked caps
   Final severity = MIN of all ceilings
   Emits downgrade_reason listing every applied cap
]
  │
  ▼
[VIBHISHANA chain synthesis — only uses CONFIRMED verdicts — unchanged]
  │
  ▼
[VYASA report:
   Executive Summary tier table (evidence × threat × runtime — multi-dim)
   Per-finding: threat_model details + downgrade_reason audit trail
]
```

---

## 5. Error Handling

Mirrors v1's defensive defaults:

**Missing `threat_model` field entirely** → KRIPA treats as strictest assumption: `attacker_privilege: "unauth"` (no cap applied from this axis) but `documented_as_intended: true` (−1 tier) AND `validation_layers_checked: []` (cap Medium). Net result: Specialist omission does NOT accidentally inflate severity; it safely downgrades.

**Specialist claims `attacker_privilege: "unauth"` but finding is on an `/admin/*` URL** → schema validator flags: `threat_model_incoherent: true` → max Medium. Prevents specialists from gaming the "unauth = no cap" rule.

**`toolchain_presence_verified: true` but no evidence provided** → KRIPA cross-checks the candidate's `evidence` field for a `which`/`Gem.loaded_specs`/`ApplicationSetting` substring. If absent → treat as `false`.

**Conflicting `documented_as_intended: true` but finding claims "undocumented behavior"** → KRIPA rejects candidate as malformed (specialist didn't think through intent).

**Stacked caps go below Informational** → clamp to Informational (no negative severity levels).

---

## 6. Testing

**Unit tests** (`test/threat-model.test.js`):

- Each sub-rule cap independently (5 sub-rules × ~3 boundary cases each = 15 tests)
- Stacking behavior: admin + working-as-designed → Informational (worst of Medium, −1 tier twice)
- Composition with v1 evidence_completeness cap: full-trace + admin → min(Critical, Medium) = Medium
- Missing field defaults: strictest assumption applied
- Schema validator rejects incoherent combinations (unauth + /admin/, docs-intended + "undocumented behavior" claim)

**Regression tests** — extend `test/gitlab-bfla-regression.test.js` and create new `test/gitlab-fp-v2-regression.test.js`:

- Replay each of the 5 real code patterns (VI-AC-001/002/003, BA-SS-001/002 — the "CONFIRMED" from today's run) and assert they emit correctly capped severity.
- Example: VI-AC-001 with `threat_model: {attacker_privilege: admin, trust_boundary_crossed: none, documented_as_intended: true}` → Informational (not High).
- Example: VI-AC-003 with `threat_model: {attacker_privilege: admin, trust_boundary_crossed: privilege-escalation, documented_as_intended: false}` → High (admin cap undone by boundary crossing).

**Integration test** — extend `test/code-review-dispatcher-integration.test.js`:
- Verify specialist prompts receive both v1 pipeline context AND v2 threat-model context
- Verify KRIPA prompt renders stacked-cap table
- Verify VYASA prompt renders threat-tier column

**verify-framework.js gates:**
- GATE-48: MUST_GATES contains `GATE-12 [THREAT-MODEL]`
- GATE-49: every squad has `threatModel` config with `{enabled, provider}`
- GATE-50: evidence-completeness module exports `capSeverityByThreatModel` function

---

## 7. Migration Plan

**Backward compat:** Candidates emitted by v1 (today's code) have no `threat_model` field. KRIPA's missing-field handling treats them safely (see §5). Existing report outputs do NOT change. All 25 test files + 47 verify gates stay green.

**Rollout order:**
1. Ship Layer 3 schema additions + Layer 4 severity-cap logic in evidence-completeness.js (pure-function, easy to test)
2. Ship Layer 1 MUST_GATE-12 in squad-framework.js (universal, applies to all squads immediately — but no specialist emits `threat_model` yet, so no effect)
3. Ship Layer 2 provider in feedback-loop.js + wire into specialist/KRIPA/VYASA prompts in event-bus.js
4. Update all 6 code-review specialist skill files with threat-model reasoning section
5. Tests + verify-framework gates
6. Regression test asserts today's GitLab CE findings would be properly capped if re-run

**No data migration needed.** Historical reports remain as-is.

---

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Specialists game "unauth" to skip admin cap | Medium | High | Schema validator checks admin-URL coherence; KRIPA cross-checks against the candidate's `file` field |
| documented_as_intended false-positive → real vulns auto-downgraded | Low | Medium | Require specialist to cite the doc/test/comment as evidence; KRIPA validates substring presence |
| Increased prompt tokens (~600 tokens per specialist prompt) | Low | Low | ~$0.001/task overhead at haiku pricing |
| Stacking underestimates cross-layer attack potential | Medium | Medium | Trust-boundary-crossed modifier undoes admin cap when the attack escalates — preserves real Criticals |
| Specialists forget to fill threat_model | Medium | Low | Default is SAFE (strictest) — forgetting downgrades, never inflates |

---

## 9. Out of Scope

- Does NOT create `/root/agents/shared/` or any new top-level hierarchy.
- Does NOT change `DHARMARAJ`'s runtime-verification role.
- Does NOT touch `finding-validator.js` (v1 substring-match check stays orthogonal).
- Does NOT add new squads; works with existing 7.
- Does NOT replace v1's evidence_completeness — stacks with it.
- Illustrations in skills refer to Rails/Django/Express/Spring/Laravel/etc. ONLY as examples; no framework detection logic.

---

## 10. Approval

**2026-04-23:** Jay gave full-autonomy approval via Telegram (msg 1643: "fix is as you like which is best you are expert"). Option C (layered, unified schema + stacked sub-rule caps) chosen based on:

- Matches v1's internal pattern (one field, multiple sub-rules).
- Best ergonomics for specialist (one object to fill, not 5 fields).
- Best composability for KRIPA (each FP class = independent rule; stack with MIN ceiling).
- Extensible: future FP classes added as new sub-fields without schema churn.

Next step: invoke `superpowers:writing-plans` to produce the implementation plan.
