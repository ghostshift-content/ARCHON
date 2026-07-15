# SPEC — ARCHON Unified Agentic Runtime

> **One** shared agentic runtime for black-box, static, and white-box. Not three pipelines. Source-slicing is
> a STATIC-mode concern only — black-box workstreams expand dynamically. Workflow: spec → code, **no commits**,
> **additive**, **flag-gated + shadow mode**; do not move/delete existing modules until all three mode-acceptance
> suites pass (§10).

## 1. Target architecture
```
User Prompt + Scope → Mission Director → Mode Adapter → Project/Target Profiler → Workstream Planner
  → Shared Task Board → Persistent Team Sessions → Streaming Candidates → Triage → Auditor → Judge
  → Evidence Engine → Report
```
All three modes share the runtime, task lifecycle, evidence pipeline, quota governor, decision log, recovery, and
UI. **Only planning, specialist instructions, and evidence requirements differ** — that difference lives entirely
in the Mode Adapter.

## 2. Mode adapters (the only per-mode surface)
| Mode | Input | Workstream unit | Confirmation |
|---|---|---|---|
| Black-box | URL, scope, creds | asset / endpoint-group / tech / attack-hypothesis | runtime evidence |
| Static | source repo | coherent context-sized source domain | source evidence |
| White-box | source + live target | source workstream → linked runtime-validation tasks | source + runtime |

- **Black-box:** scope → recon workstreams → attack hypotheses → evidence-triggered specialists → runtime candidates → validation. Workstreams **evolve during execution** (surface discovered dynamically).
- **Static:** inventory → global blueprint → coherent context-sized workstreams → **holistic review** (mapping + pattern + authz/business-logic + freehand together) → source candidates → validation.
- **White-box:** static review → exploit hypotheses → live-validation tasks → black-box specialists **using source context** → source/runtime correlation → validation. **Reuses both adapters — never a third pipeline.**

## 3. Adaptive planning (one planner, every size)
The Profiler collects: source tokens+files · features+endpoints · languages/frameworks · dependency graph ·
shared middleware/authz · trust boundaries · complexity/risk · available model context · quota/rate-limit state ·
live attack-surface size.
```
usable_context = model_context − instructions − global_blueprint − reasoning_reserve − output_reserve − safety_margin
```
The planner **packs coherent workstreams within that budget.** `ceil(total_tokens / usable_context)` is the
**minimum estimate, not the final count** (coherence + dependency locality + risk can add sessions).
Expected: tiny→1 holistic session · small→1–2 · medium→several domain sessions · large monorepo→bounded
domain/subdomain sessions with shared context · small black-box→1 coordinated session · large black-box→recon +
attack workstreams expand dynamically · white-box→source sessions + only the runtime-validation sessions findings justify.

## 3b. Session ≠ Task (the load-bearing hierarchy)
```
One mission → Mission Director session → one shared task board
  → N persistent LEAD SESSIONS (each owns ONE coherent workstream)
      → optional 0–2 bounded SUBAGENTS inside the session
  → shared findings / evidence / decision state
```
- A **session** is the **long-lived unit of project understanding** — it owns one coherent workstream (a source
  domain, or an asset/endpoint-group/hypothesis for black-box), reads it once, and keeps reasoning without
  rebuilding context.
- A **task** is a **smaller piece of work claimed inside** a session (a mapping task, a review lens, a runtime
  validation). Tasks live on the shared board; sessions claim/emit them.
- **ARCHON must NOT open a fresh session per feature × vulnerability-class.** `N = coherent workstreams that fit
  within usable context` — influenced by size, dependencies, complexity, target surface, model context, quota —
  **never by feature count alone.**
- Tiny static project → **1 lead session** reads the whole project, maps + reviews all classes + freehand in one
  understanding. Large → **N** lead sessions, each a coherent domain, communicating discoveries via the board.
- A lead may delegate to **0–2 subagents** (default) for selected internal work, then combine results — the local
  Claude-Code behaviour: one session understands its area, delegates internally, continues reasoning. **Global
  concurrency counts lead sessions AND subagents together.** No unbounded nested fan-out.

## 4. Team execution model
Mission Director → shared board → lead sessions claim workstreams → may create bounded subtasks → discoveries
create follow-ups → idle sessions claim remaining → completed work can't be re-claimed.
Rules: one owner/task · **atomic claim + lease + heartbeat** · parent/child tasks · **≤2 internal subagents per
lead by default** · global concurrency counts parents + subagents · no unrestricted nested fan-out · work-steal
only unclaimed/expired · rate-limit pauses new claims (never discards/restarts) · failed sessions **resume from
persisted context + evidence.**

## 5. Shared task lifecycle (ONE state machine)
`DISCOVERED → READY → CLAIMED → RUNNING → CANDIDATE_EMITTED → COMPLETED`
Terminals: `NO_ISSUE · BLOCKED · FAILED_RETRYABLE · FAILED_FINAL · OUT_OF_SCOPE · DUPLICATE · DISPROVEN`.
**Mapping state and review state stay separate — a failed review never erases completed mapping.**

## 6. Findings & evidence
Every candidate: `mode, workstream_id, feature, vulnerability_class, affected_asset, endpoint, affected_files,
source, sink, hypothesis, impact, evidence, confidence, duplicate_key, requires_runtime_validation,
validation_status, recommendation`. Statuses: `SOURCE_CONFIRMED · NEEDS_LIVE_VALIDATION · RUNTIME_CONFIRMED ·
DISPROVEN`. **Static evidence can never yield RUNTIME_CONFIRMED**; white-box upgrades only with linked runtime proof.

## 7. Completion gates (never "finished because idle")
- **Static:** every in-scope file inventoried · every feature mapped · every workstream reviewed holistically · every vuln lens accounted for · follow-up queue empty · all candidates triaged + judged.
- **Black-box:** recon coverage recorded · planned hypotheses done/abandoned-with-reason/blocked · no unprocessed discoveries · candidate queue drained · all judged.
- **White-box:** all static gates + every validation task done/disproven/deferred-with-reason/NEEDS_LIVE_VALIDATION.

## 8. UI
Live cards: mission strategy + why chosen · estimated source/target size · planned vs active sessions · parents +
subagents · workstreams (claimed/running/completed/blocked/remaining) · mapping vs review coverage · source↔runtime
white-box links · decision + follow-up timeline.

---

## Reuse map — what already exists vs what's new
| Runtime piece | Status | Where |
|---|---|---|
| Shared task board (claim, states, no-double-claim) | ✅ exists, **needs §5 state machine + lease/heartbeat** | `src/runtime/task-board.js` |
| Quota governor | ✅ module (needs wiring) | `src/runtime/quota-governor.js` |
| Mission workspace + workstreams | ✅ exists | `src/runtime/mission-workspace.js` |
| Decision log (unified) | ✅ | `src/pipeline/decision-log.js` |
| Agent registry (roles → lenses) | ✅ | `src/agents/registry.js` |
| Streaming triage · Judge · Evidence contract | ✅ | `src/pipeline/*`, `agents/judge-verifier.js`, `finding-schema.js` |
| Candidate schema (mode/duplicate_key/status) | ✅ (add `workstream_id`) | `src/dispatch/code-review-dispatcher.js` `toLiveCandidate` |
| Compatibility bridges | ✅ | `src/compatibility/*` |
| Session planner (§6 feature-count) | ⚠️ **replace** with profiler-driven context-budget planner | `src/runtime/session-planner.js` |
| **Profiler** (§3) | ❌ **new** | `src/runtime/profiler.js` |
| **Workstream planner** (context-budget, coherent) | ❌ **new** | `src/runtime/workstream-planner.js` |
| **Holistic review session** (§2 static core — the fix) | ❌ **new** | `src/runtime/holistic-review.js` |
| **Mode-adapter interface** (§2) | ❌ **new** | `src/runtime/mode-adapter.js` + `src/workflows/{blackbox,static,whitebox}.js` |
| **Lease + heartbeat + resume** (§4) | ⚠️ partial (recovery exists) | `src/runtime/task-board.js` |

## 9. Build sequence (one coordinated release, behind flags — shadow mode)
1. **Shared schemas + §5 state machine + mode-adapter interface** (additive scaffolding + tests).
2. **Profiler + adaptive workstream planner** (context-budget; replaces §6 ladder; shadow-only).
3. **Persistent task-board execution + lease/heartbeat + quota governance.**
4. **Replace static feature×class jobs with holistic source workstreams** (the fix). Flag `ARCHON_HOLISTIC_REVIEW`.
5. **Adapt black-box planning to the shared board** — no change to testing logic.
6. **White-box = linked static + black-box workstreams** (reuse both adapters).
7. **Unify streaming triage / evidence / Auditor / Judge / reporting** across modes.
8. **Recovery, leases, retries, dedup, completion gates.**
9. **Unified UI visibility.**
10. **Shadow-run old vs new; switch defaults only after §10 passes.** Keep current paths via compatibility adapters; move/delete nothing until all three mode-acceptance suites are green.

## 10. Test matrix (release gate)
tiny/small/medium/large/monorepo source · small+large black-box surfaces · static+white-box × multiple frameworks
· single-language + polyglot · shared middleware + cross-domain authz · huge generated/vendor dirs · cyclic deps ·
rate limits during map/review/triage/judge · crashed sessions / stale leases / daemon restart / resume · zero /
duplicate / hundreds of findings · out-of-scope discoveries · missing live target in white-box.
**PASS only when:** the mini-app completes in **one holistic session with full seeded coverage**, medium projects
shard **coherently**, large projects stay **bounded**, and all three modes use the **same observable runtime**
without losing mode-specific intelligence.
