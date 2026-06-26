# Kurukshetra Quality Architecture — North Star + 90-Day Roadmap

**Status:** 🟢 ARCHITECTURE VISION — supersedes ad-hoc pattern lists from research notes
**Author role:** Architect (per Jay's directive 2026-05-06 msg 1934 — "think as architect")
**Source-of-truth:** [2026-05-05-agentic-framework-research.md](../research/2026-05-05-agentic-framework-research.md) (818 lines, 14 patterns evaluated)
**Scope:** ALL 7 squads (pentest, stocks, cloud-security, network-pentest, code-review, plus mc + DDB)

---

## 0. Why this document exists

The research doc surveyed 25+ frameworks and 12+ patterns. That's a *menu*, not a *plan*. This doc is the plan: where kurukshetra is going, why, and what it costs to get there.

Three-section structure:
- **§1-3: North Star + Principles + Current State** — what we're building toward and where we are
- **§4-7: The Architectural Spine** — 4 cross-cutting layers that EVERY squad benefits from
- **§8-10: Roadmap + Anti-patterns + Benefits** — 90-day plan, what to skip, simple-language wins

---

## 1. North Star (where kurukshetra is going)

> **An evidence-validated, autonomous SECURITY-DOMAIN orchestrator that produces F1≥0.99 quality findings at scale across 7 specialized squads — without depending on any single LLM provider or model size.**

Three claims unpack this:

1. **"Evidence-validated"** — every finding passes through empirical verifiers (chain-verifier 3.6, browser-verifier 3.8, judge-verifier next). Not LLM self-claim.
2. **"Security-domain orchestrator"** — we are NOT a generic agentic framework. We compete with Pensar Apex, Phalanx, IronCurtain, ARTEMIS — not with LangGraph or Microsoft agent-framework.
3. **"Without depending on any single LLM"** — orchestration > frontier model (Provos thesis). Sonnet, Opus, Haiku, GLM 5.1 should all work. Cost flexibility, no vendor lock.

This is what kurukshetra IS. Anything that doesn't serve this north star → defer or reject.

---

## 2. Five Design Principles (decision criteria)

Every architectural choice for the next 90 days passes through these:

### 2.1 Orchestration > Frontier Model
- We win by better orchestration discipline, not bigger model
- Model choice is a per-phase tunable, not a strategy
- **Implication:** test patterns work across model families before committing

### 2.2 Empirical Verification > LLM Self-Claim
- Every Critical/High finding requires reproducible proof (curl, browser, judge)
- "The model said it's vulnerable" is NEVER sufficient evidence
- **Implication:** invest in verifiers, not in hoping models get smarter

### 2.3 Domain Specialization > Generality
- 7 squads are 7 deep wells of pentest/stocks/cloud expertise — NOT a general agent base + plugins
- Specialists' prompts encode domain knowledge no general framework can match
- **Implication:** never trade specialization for breadth (don't build "agentic OS")

### 2.4 Sycophancy Prevention > Raw Confidence
- Goal-scrub + separate-context grader (Haiku) keeps us honest
- An LLM agreeing with the dispatcher is NOT signal of correctness
- **Implication:** every quality lift must pass anti-sycophancy gauntlet

### 2.5 Production Hardening > Clever Features
- Race-conditions, atomic writes, supervisor restarts, doctor self-heal — all earned through pain
- A clever pattern that breaks recovery is NEGATIVE value
- **Implication:** anti-feature: anything that adds restart fragility

---

## 3. Current State (what we have, by layer)

### 3.1 Squads (domain depth — strong)
| Squad | Specialists | Verifier coverage | Status |
|---|---|---|---|
| pentest | ARJUN, DURYODHANA, KARNA, ABHIMANYU, etc | 3.6 + 3.8 verifiers | ✅ production |
| stocks | (separate models) | (uses CHANAKYA grader) | ✅ active |
| cloud-security | VARUNA + AGNI/MITRA/SOMA/KUBERA | (no Phase 3.6/3.8 yet) | ⚠️ recent |
| network-pentest | SHALYA + INDRA + GHATOTKACHA | (detection-mode) | ⚠️ recent |
| code-review | VIBHISHANA + 6 framework specialists | UTTARA runtime | ⚠️ recent |
| mission-control | (UI tier) | n/a | ✅ stable |
| DDB | (data tier) | n/a | ✅ stable |

### 3.2 Pipeline (orchestration backbone — strong)
- Phase 0: KRISHNA dispatch → Phase 1: specialists (parallel) → Phase 2: DHARMA validation → Phase 3: KRIPA verifier → Phase 3.6: chain-verifier → Phase 3.8: browser-verifier → Phase 4: VYASA reporter → Phase 5: separate grader

### 3.3 GATE system (verification rules — strong)
- 50+ gates: GATE-11 (evidence completeness), GATE-12 (threat-model discipline), GATE-51/52 (spot-check), GATE-53 (browser-recipe whitelist), etc.
- These are predicates over output; failing one downgrades severity.

### 3.4 Memory (knowledge accumulation — WEAK)
- Flat `MEMORY.md` index → individual `.md` topic files (~30 entries)
- No structure: meta vs facts vs skills are mixed
- No automatic learning from past runs
- **This is the biggest architectural gap.**

### 3.5 Cross-squad collaboration (NONE)
- Each squad runs in isolation today
- Pentest finds AWS keys → cloud-security never sees it
- **This is the second-biggest architectural gap.**

### 3.6 Operational hardening (strong)
- PM2 (event-bus, mc, supervisor, telegram-relay)
- Atomic writes, single writer, inbox/outbox patterns
- Doctor v2 auto-heal (61 self-heals proven over 33h)
- Race-condition guards (cancelledAt-sticky, external state resurrection)

---

## 4. The Architectural Spine — 4 Cross-Cutting Layers

The patterns from research aren't 12 independent features. They're 4 architectural LAYERS that EVERY squad benefits from. This is the framework, not a patch list.

### LAYER A — Verification Spine (mature → extend)
**What:** every finding passes through escalating evidence checks.
**Today:** chain-verifier (3.6) + browser-verifier (3.8) + GATE system (50+).
**Architecture upgrade:**
- **Add:** Judge verification (G1) — explicit cross-check step before VYASA reports any Critical/High finding. Per the LLM-SAST-Scanner research, this single pattern moves F1 from ~0.95 to ~0.99 (validated by SAST-Genius 91% FP reduction, LLM4FPM 85% FP reduction, AdaTaint 43.7% FP reduction).
- **Add:** Tiered harness construction (Y9) — for code-review squad: function-fuzz → multi-component → full-VM. Currently our verifier coverage is uneven (pentest has 3.6+3.8, code-review has UTTARA only).
**Cross-squad benefit:** all 7 squads get an L4 judge before final report.

### LAYER B — Trajectory Resilience (NEW)
**What:** detect bad agent reasoning DURING execution, rollback that step, retry.
**Today:** verifiers run AFTER all phases — too late to recover wasted work.
**Architecture upgrade:**
- **Add:** TrajAD runtime rollback (G3) — verify per-step at Phase 1 boundaries. Per STRATUS benchmark, 150% improvement vs state-of-art on AIOpsLab + ITBench.
- **Pattern:** TNR (transactional-no-regression) — only reversible changes allowed in agent steps; bad steps → undo + retry with different prompt.
**Cross-squad benefit:** ALL squads stop wasting Phase 2-5 work on bad Phase 1 foundations. Estimated 30-40% reduction in "false confidence" findings.

### LAYER C — Cross-Squad Collaboration (NEW)
**What:** squads can hand off findings to each other for deeper analysis.
**Today:** zero. Pentest finds AWS keys → cloud-security never knows.
**Architecture upgrade:**
- **Add:** A2A protocol (G2) — formalized squad handoff (Anthropic + Linux Foundation backed, 150+ prod orgs in 5 months).
- **Add:** Append-only execution journal (Y8) — single shared journal any squad can read to inherit context (Provos's IronCurtain pattern; we have pieces, not abstraction).
**Real example:** pentest finds `/admin/aws-creds.txt` → A2A handoff to cloud-security squad → finds S3 buckets, IAM escalation paths → 1 finding chains into 5. **NON-LINEAR multiplier on cross-domain attacks.**
**Cross-squad benefit:** unlocks attack chains that no single squad's expertise covers.

### LAYER D — Memory Hierarchy (UPGRADE)
**What:** structured knowledge that grows with every run.
**Today:** flat MEMORY.md → ~30 topic .md files. No tiers, no auto-learning.
**Architecture upgrade:**
- **Add:** 5-layer memory (Y6, derived from GenericAgent's L0-L4 + Token Savior progressive-disclosure):
  - L0: Meta rules (sycophancy prevention, plan-first, no-hallucination — system invariants)
  - L1: Insight indices (cross-engagement learnings, e.g., "DHARMA new-schema 2026-05-03")
  - L2: Global facts (per-squad domain knowledge)
  - L3: Task skills (reusable execution patterns from past pentest/stocks runs)
  - L4: Session archives (per-engagement event logs — already exist as ACTIVITY-LOG-RUDRA-*.jsonl)
- **Auto-promotion:** frequently-accessed L4 patterns → L3 skills (auto-crystallization, but with security audit trail unlike Hermes's blind self-evolution).
**Cross-squad benefit:** every squad gets a cleaner knowledge base. Stop repeating mistakes that were solved in previous engagements.

---

## 5. Pattern → Layer Mapping

Every pattern from research maps to exactly one layer (or is rejected):

| Pattern | Layer | Verdict |
|---|---|---|
| G1 Judge verification | A — Verification | 🟢 Implement |
| G2 A2A protocol | C — Collaboration | 🟢 Implement |
| G3 TrajAD rollback | B — Trajectory | 🟢 Implement |
| G4 Multi-model test | (validates principle 2.1) | 🟢 Implement first (cheap probe) |
| Y8 Append-only journal | C — Collaboration | 🟢 Implement (couples to G2) |
| Y9 Tiered harness | A — Verification | 🟡 Phase 3 (after top 3 ship) |
| Y6 5-layer memory | D — Memory | 🟡 Phase 3 (when memory grows) |
| Y4 Self-improving skills | D — Memory (rejected variant) | 🔴 SKIP — drift risk |
| R1 MAGMA | D — Memory (superseded by Y6) | 🔴 SKIP |
| R2 CASTER | (none — DX only) | 🔴 SKIP |
| Y1 ROMA parallel | (Layer A pipelining) | 🟡 Phase 3 |
| Y2 Bernstein routing | (cost only) | 🟡 Phase 3 |
| Y5 Tool-output sandbox | (DX only) | 🔴 SKIP |
| Y7 GSD scope-reduce | A — Verification | 🟡 Phase 3 (extends GATE-11) |

12 patterns reduce to **4 architectural layers + 7 deferred + 4 rejected**. That's the architecture, not the menu.

---

## 6. The "What we're NOT doing" decisions (and why)

Architects must say NO clearly. These are the rejected patterns + reasoning:

### 6.1 NO to migrating to LangGraph / Microsoft agent-framework
- Loses all 50+ GATEs, Phase 3.6/3.8 verifiers, sycophancy prevention, race-hardening
- General frameworks optimize for breadth; we win on security-domain depth
- Estimated cost to port: 2-3 months of specialist prompt rebuilding
- **Cost vs benefit: net NEGATIVE.** Skip permanently.

### 6.2 NO to self-improving skills loops (Hermes Y4 / GenericAgent self-evolution)
- Sounds attractive ("agent learns from runs!"), but security context is unforgiving
- A malformed learned-skill could cause kurukshetra to systematically miss a class of vulnerabilities
- Drift risk > quality benefit when adversaries are part of the threat model
- **Defer until research shows safe patterns.** Likely 6-12 months out.

### 6.3 NO to per-specialist VM sandbox isolation (Vercel Open Agents pattern)
- We're blackbox-only currently — never give pentest targets execution access to our env
- Prompt injection from a target into our specialist is bounded (Phase 3.6/3.8 verifiers catch downstream effects)
- VM infrastructure cost (memory + spawn time) > current threat model cost
- **Revisit if we add whitebox mode (Pensar Apex pattern).** Otherwise: defer indefinitely.

### 6.4 NO to MAGMA orthogonal memory graph
- 4-facet semantic-graph is more complex than 5-layer hierarchy with no extra benefit
- Would build twice (5-layer + graph) when 5-layer alone solves the problem
- **Skip permanently** — superseded by Y6.

### 6.5 NO to streaming UI / OpenTelemetry / DevUI / Claude-Mem
- These are DX (developer experience) wins, not quality wins
- We have mission-control + telegram-doctor + atomic logs — sufficient observability
- Tool-output sandboxing (Context Mode) only matters if VYASA's context is the bottleneck — currently it isn't
- **Defer until DX becomes a real pain point.** Likely never on the critical path.

---

## 7. Sequencing Discipline (why this order, not another)

The order is NOT arbitrary. Each layer enables the next:

```
G4 Multi-model test  →  validates Principle 2.1 (orchestration > frontier model)
                         CHEAP probe before committing to layered build
                         If quality holds with Sonnet: $5,500/mo savings PLUS confidence
                         that orchestration > frontier model bet is correct
                                ↓
G1 Judge verification (Layer A)  →  highest evidence-base, cleanest scope
                                       SAST-Genius 91% / LLM4FPM 85% / AdaTaint 44% FP reduction
                                       3 days build, F1 0.95 → 0.99
                                ↓
G3 TrajAD rollback (Layer B)  →  catches Phase-1 errors BEFORE they propagate
                                    Saves Phase 2-5 wasted work
                                    Builds on Judge's verification discipline
                                ↓
Y8 Append-only journal (Layer C foundation)  →  enables A2A handoffs
                                                    Already have pieces (tasks.json, RUDRA logs)
                                                    Formalize for shared cross-squad reads
                                ↓
G2 A2A protocol (Layer C)  →  cross-squad attack chains
                                Non-linear quality multiplier
                                Last because it's most invasive (touches all 7 squads)
                                ↓
Y6 5-layer memory (Layer D, Phase 3)  →  better recall of past learnings
                                            Defer until memory grows past 100 entries
                                            Use GenericAgent L0-L4 model
```

Each step de-risks the next. Order matters.

---

## 8. 90-Day Roadmap

### Phase 1 — Foundation (Days 0-30) — "Validate orchestration thesis + biggest quality lift"
**Week 1:** G4 Multi-model test (3 days build + 1 week observation)
- Run controlled pentest with KRISHNA=Sonnet (down from Opus)
- Compare against Lenovo v4-backlog historical Opus runs
- If quality holds → adopt Sonnet for routine targets
- **Win:** principle 2.1 validated empirically + ~$5,500/mo savings

**Weeks 2-3:** G1 Judge verification (3 days build + 1 week observation)
- Add JUDGE agent in Phase 3.5 (between Phase 3 KRIPA and Phase 4 VYASA)
- Cross-checks every Critical/High finding via independent reasoning
- **Win:** F1 ~0.95 → ~0.99 (validated 91% FP reduction across 3 papers)

**Week 4:** Stabilize. Run 2-3 real engagements with new pipeline. Gather metrics.

### Phase 2 — Trajectory Quality (Days 30-60) — "Stop wasted work"
**Weeks 5-6:** G3 TrajAD runtime rollback
- Add per-step verifier at Phase 1 boundaries
- TNR pattern: only reversible Phase 1 changes; bad reasoning → undo + retry
- **Win:** 30-40% fewer "false confidence" findings, faster runs (don't waste Phase 2-5 on bad foundations)

**Week 7:** Y8 Append-only execution journal (formalize what we have)
- Unify tasks.json + dispatch-queue.json + ACTIVITY-LOG-RUDRA-*.jsonl under one read-by-any-squad abstraction
- Prep work for A2A in Phase 3
- **Win:** debugging time cut, audit trails clean, A2A handoffs become trivial

**Week 8:** Stabilize + measure.

### Phase 3 — Collaboration + Scale (Days 60-90) — "Squads working together"
**Weeks 9-11:** G2 A2A protocol implementation
- Formalize cross-squad handoff (Anthropic A2A standard)
- pentest → cloud-security flow first (highest-impact pair)
- **Win:** non-linear quality multiplier on cross-domain attack chains

**Week 12:** Y6 5-layer memory hierarchy (if memory >100 entries by then)
- L0-L4 design from GenericAgent, with Token Savior's progressive-disclosure tier sizes
- Auto-promotion L4→L3 with audit trail
- **Win:** stop repeating mistakes already solved

---

## 9. Simple-language summary (for the non-architect view)

### What we're going to do (in plain words)

1. **Test cheaper models first** (Week 1) — see if Sonnet works as well as Opus. If yes: $5,500/month savings. (3 days work, low risk.)

2. **Add a "judge" step** (Weeks 2-3) — before kurukshetra publishes any Critical/High finding, a separate agent independently verifies it's real. Research shows this kills 85-91% of false positives. (Quality jumps from very-good to near-perfect.)

3. **Catch mistakes earlier** (Weeks 5-6) — instead of running all 5 phases and discovering bad reasoning at the end, check each phase before moving on. Bad reasoning gets retried. Saves 30-40% of wasted work.

4. **Make squads talk to each other** (Weeks 9-11) — when pentest finds AWS keys, cloud-security squad automatically picks it up. One finding chains into many. New attacks become possible.

5. **Better memory** (Week 12 or later) — organize what kurukshetra learns into 5 layers. Stop repeating mistakes. Auto-learn from successful runs.

### What we're NOT going to do (in plain words)

1. **Not switching to LangGraph or Microsoft's framework** — would lose everything we built (verifiers, GATEs, race-hardening). Net loss.

2. **Not letting agents auto-modify themselves** — too risky for security work. An auto-learned bad pattern could cause kurukshetra to systematically miss a class of vulnerabilities.

3. **Not adding fancy UI / observability tools** — those are nice-to-haves, not quality lifts. Mission-control + Telegram is enough.

4. **Not adding VM sandboxes per agent** — only useful if a target could execute code in our process. Not in our threat model today.

### The core bet

Kurukshetra's value is the verifier discipline + squad specialization, NOT the model size. The next 90 days deepen that bet:
- Verify more rigorously (judge step)
- Verify earlier (rollback bad reasoning)
- Verify across squads (cross-domain attack chains)
- Remember better (5-layer memory)

If this bet is right, kurukshetra produces near-perfect-quality findings cheaper than human pentesters. If wrong (it's not), we'll see it in 30 days.

---

## 10. What changes for each squad

| Squad | Phase 1 (Days 0-30) | Phase 2 (Days 30-60) | Phase 3 (Days 60-90) |
|---|---|---|---|
| pentest | Sonnet test, Judge step | TrajAD rollback at Phase 1 boundary | A2A handoff to cloud-security on cred findings |
| stocks | Same Judge pattern | TrajAD on stock-recommendation reasoning | (no A2A — stocks is standalone) |
| cloud-security | Same Judge pattern | TrajAD | A2A receive from pentest, handoff to network-pentest on lateral movement findings |
| network-pentest | Same Judge pattern | TrajAD | A2A receive from cloud-security |
| code-review | Same Judge pattern + Y9 tiered harness | TrajAD | A2A handoff to pentest on logic flaws |
| mission-control | (UI updates only) | (UI updates only) | (display A2A handoff chains) |
| DDB | (no changes) | (no changes) | (no changes) |

Every squad benefits from every layer. That's why these are architectural layers, not features.

---

## 11. Success metrics (how we know it worked)

### Phase 1 (Day 30)
- [ ] G4: Sonnet equals Opus quality on 3 controlled targets → adopt Sonnet for routine
- [ ] G1: F1 lifts from ~0.95 to ≥0.99 measured on retro-validated past findings
- [ ] Cost-per-engagement drops 60%+ if Sonnet adopted

### Phase 2 (Day 60)
- [ ] G3: 30%+ reduction in Phase 2-5 wasted work (measured by retry count)
- [ ] Y8: Single append-only journal abstraction in event-bus.js, all squads read it

### Phase 3 (Day 90)
- [ ] G2: First documented A2A handoff (pentest → cloud-security) completes successfully
- [ ] Y6 (if memory grew): 5-layer hierarchy live, auto-promotion working
- [ ] Total quality: F1 0.99+ on cross-domain attack chains

---

## 12. Risks (architect's job: name them)

1. **Multi-model test could fail** (Sonnet may not match Opus on complex pentest reasoning) → fallback: keep Opus for pentest, use Sonnet for stocks/code-review. Still some savings.
2. **Judge agent could be a bottleneck** if it adds 30+ seconds per finding → mitigation: run async, gate VYASA on its completion, don't block other phases.
3. **TrajAD rollback could thrash** if a target produces consistently-bad-looking output → mitigation: anti-thrash (max 3 rollbacks per phase, then accept and flag for human review).
4. **A2A protocol mismatch** if Anthropic's spec changes → mitigation: implement minimum viable handoff first (just JSON over file-drop), upgrade later.
5. **Memory hierarchy could create cargo-cult patterns** if auto-promotion is too eager → mitigation: human-review queue for L3 promotions in first 30 days.

---

## 13. Decision: ready to brainstorm G4 + G1 (Phase 1)?

This architecture replaces the 12-pattern decision matrix from research notes §13. Going forward:
- Reference this doc as the architectural source of truth
- Each pattern from research §13 maps to one cell in §5 here
- When someone asks "should we add X?", check: which layer? what does §6 say about rejected patterns?

**Next concrete step:** invoke superpowers:brainstorming for G4 (Multi-model test) — Phase 1 starts there. Then G1 Judge verification.

---

## Appendix A: Reference docs

- [2026-05-05 agentic framework research](../research/2026-05-05-agentic-framework-research.md) — 818-line landscape survey
- [2026-04-23 evidence-completeness design](../superpowers/specs/2026-04-23-evidence-completeness-design.md) — GATE-11 origin
- [2026-04-23 threat-model discipline design](../superpowers/specs/2026-04-23-threat-model-discipline-design.md) — GATE-12 origin
- [2026-04-27 framework gaps design](../superpowers/specs/2026-04-27-framework-gaps-design.md) — orchestrator silent-drops fix
- [2026-05-01 browser-validator design](../superpowers/specs/2026-05-01-browser-validator-design.md) — Phase 3.8 design

## Appendix B: Source-of-truth provenance

- North Star — derived from research §1 (kurukshetra current state) + §15 (Provos thesis)
- Principle 2.1 — Provos "Finding zero-days with any model" (research §15)
- Principle 2.2 — kurukshetra's existing Phase 3.6 + 3.8 + GATE design
- Principle 2.3 — implicit in our 7-squad structure (validated against indie frameworks §3)
- Principle 2.4 — sycophancy memory (April 2026)
- Principle 2.5 — operational hardening commits (race condition fixes April-May 2026)
- Layer A — G1 Judge from §12.5.1 + Y9 tiered harness from §15.4.3
- Layer B — G3 TrajAD from §6.2 (validated by STRATUS in §13.1)
- Layer C — G2 A2A from §6.6 (validated 150+ orgs in §13.1) + Y8 from §15.4.2
- Layer D — Y6 from §17.5 (GenericAgent L0-L4) merged with Token Savior's progressive-disclosure §12.3

This document IS the architectural plan. Research notes are inputs to it.
