# Evidence-Completeness Discipline — Cross-Squad Design

**Date:** 2026-04-23
**Author:** SANJAY (via Jay's approval)
**Status:** APPROVED (option C — hybrid)
**Scope:** All 7 Kurukshetra squads (pentest, stocks, red-team, cloud-security, network-pentest, code-review, ai-security), repository-agnostic

---

## 1. Problem Statement

On 2026-04-23 we shipped a white-box code-review of GitLab's `admin/` controllers. The code-review squad emitted 4 Critical + 9 High "missing admin gate" findings based on **controller-inheritance evidence alone**:

```
class Admin::BroadcastMessagesController < ApplicationController  # expected: Admin::ApplicationController
```

Runtime validation (Jay's docker reproduction) flipped the top finding to **FALSE POSITIVE** — GitLab's admin gate lives elsewhere in the request pipeline (likely middleware + `authenticate_user!` hook + some mode enforcement), not in the controller class declaration.

**Root cause class:** Specialists emit findings from LOCAL evidence (single file, single pattern match) without tracing the full pipeline from user input to sink. Any layer of protection we didn't inspect can silently invalidate our claim.

**Why existing discipline didn't catch it:**
- `MUST_GATES` (10 gates in squad-framework.js): cover output hygiene (no hedging, proof required, fresh eyes). Don't require end-to-end pipeline tracing.
- `feedback-loop.js` (disproven cache + lessons): per-target learning, no history for this specific bug class.
- `finding-validator.js` (evidence_quote check ≥15 chars): passed — we had `file:line` cite. Local evidence counted as "quoted".
- `DHARMARAJ` (runtime exploit verifier): didn't run (no deployUrl, code-review skipped Phase 3 by design).

**The blind spot:** Static analysis without runtime grounding + no pipeline-completeness requirement.

---

## 2. Goal

Zero false positives in the Critical/High severity tier across all squads, achieved by requiring **evidence chain completeness** before any specialist can claim those severity levels. Keep the legitimate "leads" (partial-evidence findings) as LOW/MEDIUM with explicit `needs_live_validation` flag — never drop them.

**Success criteria:**
- A Critical/High finding in any report comes with a `pipeline_trace` showing every layer inspected.
- Partial-evidence findings auto-downgrade, never silently drop.
- Works for ANY target repository, not hardcoded to GitLab/Rails/any framework.
- No regression: existing pentest / cloud-security / network-pentest squads continue working.
- Measurable: run same GitLab code-review → DH-AC-001 emits as MEDIUM-suspected, not CRITICAL-confirmed.

---

## 3. Architecture — Option C (Hybrid)

Two decoupled layers:

### Layer 1 — Universal meta-discipline (`MUST_GATE-11 [CHAIN-COMPLETE]`)
Static gate text added to `squad-framework.js` in the `MUST_GATES` string (and parallel `MUST_GATES_STOCKS`). Auto-injected into every specialist, KRIPA, chain-analysis, and VYASA prompt across all 7 squads via existing `getSquadGates(squad)` mechanism.

Text is deliberately abstract — each squad's evidence chain has different semantics:

> **GATE-11 [CHAIN-COMPLETE]** — Before claiming any CRITICAL or HIGH severity finding, you must trace the evidence chain end-to-end in your squad's domain. Local-only evidence (single file, single config value, single packet, single line) is INSUFFICIENT for CRITICAL/HIGH. The chain must cover: input source → every defense layer the input passes through → the sink where the vulnerability manifests. If ANY layer was not inspected, downgrade severity and emit `evidence_completeness` metadata explaining what was skipped. Squad-specific chain examples live in each squad's skill files.

### Layer 2 — Code-review deep provider (`getPipelineCompletenessContext`)
New function in `feedback-loop.js` alongside existing `getDisprovenContext` / `getSquadLessons` / `getFreshEyesNotice`. Gated by squad-framework.js config flag.

Returns framework-agnostic white-box pipeline-trace guidance — what to inspect for each finding type, in generic terms that cover Rails / Django / Express / Spring / Laravel / Go / .NET / PHP / Ruby / Python conventions. Examples of layer types the specialist must check:

- Access control: router constraints, middleware auth filters, controller-level filters, framework admin-namespace conventions, policy/ability/CanCan/Pundit checks
- XSS: template auto-escape, explicit sanitizer calls, CSP header, framework safe-output helpers
- SQLi: ORM parameterization, prepared statements, raw-SQL fallbacks
- SSRF: URL validation layer, allowlist, DNS/IP resolver checks
- RCE: shell-escape, deserialization safety, template injection guards
- ATO: session store, token issuance/revocation, MFA enforcement, password reset flow

Config flag in squad-framework.js `SQUAD_TYPES[squad]`:
```js
{
  ...
  evidenceCompleteness: {
    enabled: true,           // code-review: true, others: false initially
    provider: 'pipeline',    // future: 'iam-chain' for cloud, 'cve-banner' for network
  }
}
```

### Candidate output schema (new fields, every squad)

Every specialist candidate emitted to `/root/intel/<squad>/findings/<taskId>/<agent>-<framework>.jsonl` must include:

```json
{
  "evidence_completeness": "full" | "partial" | "local_only",
  "pipeline_trace": ["router_constraint", "middleware_auth", "controller_ancestors", "before_actions", "sink"],
  "upstream_defenses_checked": [
    {"layer": "middleware", "file": "app/middleware/auth.rb", "outcome": "none_applicable"},
    {"layer": "controller_parent", "file": "app/controllers/application_controller.rb", "outcome": "authenticate_user_only"}
  ],
  "runtime_verification_command": "curl -b 'session=<NON_PRIVILEGED>' http://TARGET/admin/broadcast_messages",
  "expected_true_positive_signature": "HTTP 200 + body contains 'Broadcast Messages'",
  "expected_false_positive_signature": "HTTP 404 with X-Gitlab-Custom-Error header, OR HTTP 302 to /users/sign_in, OR HTTP 403"
}
```

Existing fields (`id`, `framework`, `pattern`, `severity`, `title`, `file`, `line`, `source`, `sink`, `gap`, `attack_plan`, `evidence`, `needs_live_validation`) are unchanged.

### KRIPA severity cap

In KRIPA's cross-check prompt, add auto-downgrade logic:

| `evidence_completeness` | Max severity KRIPA can assign | Default `needs_live_validation` |
|---|---|---|
| `full` | Critical (specialist's claim respected) | false |
| `partial` | Medium | true |
| `local_only` | Low | true |

KRIPA's verdict file includes `severity_capped: true` + `downgrade_reason` whenever it reduces the specialist's severity.

### VYASA report requirement

Every Critical / High finding in the final report must include:
- `runtime_verification_command` exactly as emitted by specialist
- `expected_true_positive_signature` and `expected_false_positive_signature`
- Explicit "**Assumptions not verified:**" bullet list

Executive Summary table structure changes:

| Severity | Runtime-Confirmed | Full-Trace Suspected | Partial-Trace Suspected | Local-Only Suspected |
|---|---|---|---|---|

Readers see exact confidence tier per finding.

---

## 4. Data Flow

```
[Specialist reads source]
  │
  ▼
[Specialist emits candidate with pipeline_trace + evidence_completeness]
  │
  ▼
[UTTARA runtime validation if deployUrl]
  │  → runs runtime_verification_command
  │  → compares to signatures
  │  → flips evidence_completeness to 'full' if runtime-confirmed
  ▼
[KRIPA cross-check + severity cap]
  │  → reads evidence_completeness
  │  → auto-downgrades severity per table above
  │  → emits KRIPA-VERDICTS with severity_capped + downgrade_reason
  ▼
[VIBHISHANA chain synthesis]
  │  → only uses CONFIRMED verdicts (unchanged behavior)
  ▼
[VYASA report]
  │  → renders tier table in executive summary
  │  → every C/H finding shows the 3 signature fields
  │  → "Assumptions not verified" bullet list per finding
```

---

## 5. Error Handling

**Specialist emits candidate with no `evidence_completeness` field:** KRIPA treats it as `local_only` (strictest assumption). Specialist cannot game the system by omitting the field.

**Specialist claims `full` but `pipeline_trace` has fewer than squad's minimum required layers:** KRIPA auto-downgrades to `partial` + logs `trace_too_short: true`.

Minimum required layer counts per squad (v1 values, tunable via squad-framework.js):

| Squad | `pipelineMinLayers` | Rationale |
|---|---|---|
| code-review | 3 | router/middleware/controller-chain at minimum for any BFLA/auth claim |
| cloud-security | 2 | IAM policy + effective permission verification |
| network-pentest | 2 | port/banner + version/CVE match |
| pentest | 2 | endpoint + exploit behavior |
| red-team | 2 | inherits from target squad |
| stocks | 0 | no vuln concept, field not enforced |
| ai-security | 3 | model/prompt/output layers for prompt injection claims |

**`runtime_verification_command` is missing on a C/H candidate:** KRIPA auto-downgrades severity AND flags `unverifiable_by_design`.

**`expected_false_positive_signature` is identical to `expected_true_positive_signature`:** KRIPA rejects candidate as malformed (specialist didn't think through FP case).

**UTTARA cannot reach target (target offline):** candidate retains its specialist-claimed `evidence_completeness` (typically `partial`), KRIPA caps to MEDIUM, `runtime_status: 'blocked_env'`.

---

## 6. Testing

**Unit tests** (`test/evidence-completeness.test.js`):
- `evidence_completeness: 'full'` candidate with Critical severity passes through KRIPA uncapped
- `evidence_completeness: 'partial'` Critical candidate downgrades to Medium
- `evidence_completeness: 'local_only'` Critical candidate downgrades to Low
- Missing `evidence_completeness` field defaults to `local_only`
- Identical TP/FP signatures trigger rejection
- `runtime_verification_command` missing on C/H triggers flag + downgrade

**Integration test** (extend `test/code-review-dispatcher-integration.test.js`):
- Mock specialist emits a Critical candidate with full pipeline_trace → reaches VYASA as Critical
- Mock specialist emits a Critical candidate with local_only → KRIPA downgrades to Low, VYASA renders in "Local-Only Suspected" column

**Regression test** (`test/gitlab-bfla-regression.test.js`):
- Simulates the exact DH-AC-001 FP from 2026-04-23 GitLab run
- Assert: with Layer 2 provider active, specialist would have emitted `evidence_completeness: 'partial'`
- Assert: KRIPA downgrades to Medium
- Assert: report does NOT show Critical BFLA

**Test invariants** (extend `verify-framework.js`):
- GATE-N: every squad with `gateStyle: 'security'` has `GATE-11 [CHAIN-COMPLETE]` in its `MUST_GATES`
- GATE-N+1: every candidate JSONL has `evidence_completeness` field (validated against known corpus)

---

## 7. Migration Plan

**Backward compatibility:** candidates without `evidence_completeness` field are treated as `local_only` (safe default). No pre-existing reports are invalidated — they're just rendered in the "Local-Only Suspected" column if re-processed.

**Rollout order:**
1. Ship Layer 1 (MUST_GATE-11 text + severity-cap logic in KRIPA + VYASA schema update) — active for all 7 squads immediately
2. Ship Layer 2 (getPipelineCompletenessContext for code-review) with `enabled: true` on code-review only
3. Extend to cloud-security, network-pentest one squad at a time as FPs emerge

**No data migration needed** — existing `/root/intel/` files continue to work as-is.

---

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Specialists claim `full` without actually tracing | Medium | High (false confidence) | KRIPA auto-downgrades if `pipeline_trace` shorter than minimum; verify-framework test checks corpus |
| Universal gate dilutes attention in other squads | Low | Medium | Gate text is generic + actionable for each domain; reviewed per-squad after 2 weeks |
| Partial-evidence downgrade buries real findings | Low | Medium | Findings stay in report with explicit tier; human reviewer sees them; upgrade path via UTTARA |
| Extra prompt context increases cost | Low | Low | ~500 tokens per specialist prompt, ~$0.001/task overhead at haiku pricing |
| Schema change breaks existing tests | Medium | Low | Default to `local_only` on missing field; add fields, don't remove |

---

## 9. Out of Scope

- **NOT** creating `/root/agents/shared/` directory or any new top-level hierarchy
- **NOT** changing squad-framework.js from config to logic
- **NOT** touching `DHARMARAJ`'s SOUL.md (it already demands runtime verification; this spec complements, doesn't replace)
- **NOT** rewriting `finding-validator.js` (its substring-match check stays; new mechanism is orthogonal)
- **NOT** adding new squads; works with existing 7
- **NOT** hardcoded to GitLab, Rails, Ruby, or any specific framework — all language/framework/tool examples in skills are illustrative, never checked by code

---

## 10. Approval

**2026-04-23:** Jay approved option C (hybrid) with DOWNGRADE-not-DROP and 3-tier severity cap via Telegram (msg 1627: "Kar de c sab verify kar bad me").

Next step: invoke `superpowers:writing-plans` skill to produce the implementation plan.
