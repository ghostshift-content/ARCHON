# Kurukshetra → Inside Claude Code: Future-Proof Architecture Vision

**Date:** 2026-06-03
**Status:** DESIGN ONLY — awaiting Jay's approval. **No production code changed.**
**Asked by:** Jay — "move the full framework inside Claude Code so it uses all powerful new CC features (workflows + whatever ships later), gets us off the `claude -p` architecture, and is future-proof / never outdated. Don't worry about API cost (subscription). + an engine that automatically reads the latest Claude docs and adopts the best new features itself."
**Method:** two multi-agent research+design workflows (20 agents total, web + codebase, candidate architectures adversarially judged + red-teamed against live docs).

---

## TL;DR

Two pillars, independently valuable:

1. **The architecture** — relocate execution into Claude Code behind a **ports-and-adapters** layer, on top of a thin **durable spine** that stays custom (because CC has no durable queue / 24-7 daemon). Winner of a judged 3-way: **STRANGLER + ADAPTER-CORE** (47/54), grafted with native-maximal's plugin-bundle feature-ride and agent-sdk-host's SessionStore-for-transcripts.
2. **The self-updating engine (codename ASHWATTHAMA)** — a closed, plan-first loop that watches official Claude docs, detects new quality/speed features, drafts an adapter on a branch (never prod), benchmarks it against a golden eval set, runs your 92 gates, pings you for one tap, adopts behind a flag, auto-rolls-back on regression. This is the literal answer to "auto-read the latest docs and adopt the best."

**The one move worth doing regardless of every decision below:** Wave 1 — move the deterministic, non-LLM verifiers (chain-verify curl, browser-verify Playwright, WAF, scope-validate) to **MCP tools**. Zero credit, every CC session inherits them, relieves the June-15 pool, and delivers value even if you reject the rest.

**The honest crux:** "fully inside CC" is impossible without losing durability, AND "subscription = unlimited" is false (June-15 capped credit pool). The winning design respects both — it never dissolves the daemon, and it never bets the architecture on the optimistic billing outcome.

---

## Two hard facts that shaped everything (verified live, 2026-06-03)

- **June-15 capped credit pool.** From 2026-06-15, `claude -p` AND Agent SDK usage on subscription draw a *separate, capped monthly pool* (Max5x $100 / Max20x $200, full API rates, no rollover, **hard-stop on depletion**). Kurukshetra is already 100% `claude -p` → already on the wrong side. **Interactive terminal CC is UNAFFECTED** — that's the load-bearing escape hatch.
- **Session-scoped ephemerality.** CC Workflows + subagents die with the session; exit mid-run = next session starts fresh. They cannot own durability. The daemon must stay.

---

## PILLAR 1 — The Architecture (STRANGLER + ADAPTER-CORE)

### The boundary rule (one sentence)
> The **spine owns state and time** (triggers, queue WAL, checkpoints, locks, cancel, credit budget, final state writes, memory-of-record); **CC primitives execute** (LLM reasoning, fan-out, verification, report drafting). Adapters return canonical data; only the spine mutates pipeline state. Enforced by `GATE-DURABILITY-OWNERSHIP`.

### Tier 1 — DURABLE SPINE (PM2/systemd, 24/7, runs ZERO LLM, ~600 lines down from ~10,500)
`shell-orchestrator.js` (event-bus.js gutted to a phase-driver calling ports): owns the dispatch-queue WAL, events.jsonl + checkpoint.json, phase-resume, advisory file-locks, atomic writes, convergent reconcilers (cancelledAt-sticky healing, external-cancel, stale-recovery), cancel registry. `supervisor.js` stays (stale-checkpoint detect, restart, zombie reap). `telegram-relay/inbound.js` unchanged (CC telegram plugin stays OFF per the 409 decision).

### Tier 2 — SESSION-SCOPED EXECUTION (ephemeral, re-derivable from spine state)
- **Squads → CC plugins** (`plugin.json` bundling subagents + skills + hooks + `.mcp.json` + monitors), private marketplace, SemVer + SHA-pin + beta/stable channels. The plugin manifest IS the adapter-delivery surface.
- **Specialists → subagents** (`.md` + YAML frontmatter). Context isolation = free fresh-eyes/de-anchoring + a credit-saver. The `model` field IS the native modelRouter (kills the hardcoded-model-string debt).
- **Leaders → orchestrator-level roles, NOT subagents** (hard constraint: subagents can't nest). Flatten leader→specialist topology; >1 fan-out level uses the Workflow adapter.
- **18 phases → a phase-driver calling ports**; deterministic phases on MCP (zero credit), LLM phases on subagents.

### The 8 ports (each is an Anti-Corruption Layer)
`OrchestratorPort · AgentRunnerPort · VerifierPort · ReporterPort · TriggerPort · MemoryStorePort · CostGovernorPort · FindingPort`

### The LLM execution seam (the core future-proofing chokepoint)
Single file `agents/runner/agent-runner.js`: `runAgent({squad,phase,agentName,systemPrompt,userPrompt,model,tools})`. Locked by `GATE-SEAM-CHOKEPOINT` (zero `spawn('claude','-p')` outside it). Three adapters behind it:
- **InProcessOrchestrator** — durable floor, `requires:[]`, always selectable, today's path (rollback floor).
- **InteractiveSessionRunner (PREFERRED, conditional)** — persistent interactive PTY session driven via stdin/MCP. IF programmatic-interactive bills as interactive (off the cap) → bulk-LLM cost win. **UNVERIFIED — meter-probe Wave 3.**
- **AgentSdkRunner** — capped-pool fallback with full native subagents/structured-outputs/hooks.

### Concept → primitive → adapter (the map)

| Kurukshetra | CC primitive | Port | Future-proof note |
|---|---|---|---|
| 18-phase pipeline | InProcess (floor) + Dynamic Workflows (accelerator) | OrchestratorPort | Workflows session-scoped + preview → wrap in checkpoint/retry; `requireDurable` excludes them from autonomous jobs until durable variant ships |
| `claude -p` shell-out (:567/:2787/:2969) | Interactive PTY / SDK / `claude -p` | AgentRunnerPort | THE seam. 3 spawns → 1 chokepoint. Billing = meter-probe before trust |
| Squads ×7 | CC plugin | (manifest) | New feature = new file + version bump, gated by 92 gates |
| Specialists | Subagent (.md) | AgentRunnerPort | ~1:1. Isolation = free de-anchoring; `model` field = modelRouter |
| Leaders | Orchestrator role | OrchestratorPort | Subagents can't nest → flatten; Agent Teams = future native A2A |
| KRIPA/DHARMA | Subagent + SubagentStop hook + structured outputs | VerifierPort/FindingPort | Constrained decoding shrinks parse-repair; validateFinding + url-extractor stay as ACL |
| DHARMARAJ judge | Subagent + structured verdict + promotion-gate hook | JudgePort | Rubric/promotion stay custom; **migrate LAST** (false-promote publishes org-wide) |
| VYASA reporter | Subagent + Stop hook → outbox | ReporterPort | cleanReportForPublish scrub stays custom (no CC equivalent) |
| Chain-verify 3.6 / browser-verify 3.8 | **MCP tools** (curl + Playwright) | VerifyPort | **HIGHEST-VALUE/LOWEST-RISK: zero credit, migrate FIRST** |
| verify-framework 92 gates | runtime → hooks; source/schema → CI Routine | (+6 gates) | Non-blocking hooks must try/catch + never exit-2 except 0.0/3.08/5 |
| Per-agent memory | JsonlFileMemory (truth) + Memory tool (cache) | MemoryStorePort | Subagents don't inherit history → inject explicitly |
| Triggers (cron/Telegram) | Spine (stay) + Routines (secondary) | TriggerPort | Routines: 1hr-min, daily cap, draw subscription → batch/debounce |
| Cost-tracking (:1229-1238) | **Repurpose** → credit-pool ledger | CostGovernorPort | Dollar-accounting dead; token signal = credit-burn proxy post-June-15 |
| Durable queue/locks/checkpoint | STAYS CUSTOM (no native durable queue) | — + SessionStore (transcripts only) | SessionStore fixes the read-modify-write race for transcripts only; state never moves into it |

### What gets DELETED (the subscription + native dividend)
Custom `claude --print` stdout JSON parsing (:1850/:2049); spawnAgent argv plumbing (:2947-2975) + OAuth-vs-API-key branching; E2BIG/ARG_MAX + 120KB prompt-truncation guards; stdout stream reconstruction (`broadcastAgentStream`, `.stream` manifests); top-level-result.model attribution bug-class + `--bare` caching gymnastics; spot-check/grader stdout parsing; custom Playwright spawn (→ Playwright MCP); Langfuse **dollar** cost spans. **NOT deleted, REPURPOSED:** the per-token pricing tables become the CostGovernor credit-burn meter — deleting them wholesale would be a mistake post-June-15.

### Migration waves (incremental, gated, zero-downtime)
- **Wave 0 — Scaffolding** (zero behavior change): extract 8 ports as pass-throughs; introduce `agent-runner.js` chokepoint wrapping the 3 spawns identically; `adapter-routing.json` with InProcess as the only floor; land 6 new gates + GATE-FAILSOFT (~98 gates). Accept: byte-identical output to pre-refactor.
- **Wave 1 — Zero-credit MCP verifiers FIRST** (probe-independent relief): 0.5/1.6/3.06/3.07/3.6/3.8 → MCP tools. Zero credit, net pool relief BEFORE any pool-billed adapter. **This is net-positive standalone.**
- **Wave 2 — CostGovernorPort + runtime hooks**: credit ledger (interactivePool vs sdkCreditPool, reserve-before-dispatch, GATE-CREDIT-BUDGET hard-cap ~70% → auto-degrade to floor); 3 blocking gates → PreToolUse hooks, rest → fail-soft. Must land before any pool-billed autonomous adapter.
- **Wave 3 — THE BILLING METER-PROBE** (gates everything downstream): drive a long-lived interactive PTY session, read which pool it debits. Interactive → InteractiveSessionRunner preferred (bulk LLM off the cap). SDK-pool → still wins on quality, replan to lead on MCP verifiers + governor.
- **Wave 4 — Specialist subagents on highest-volume squad, in shadow** (1-in-K sampling, not shadow-all; 20 clean samples → flip → **delete old path within N days**). Stocks sequential during shadow (parallel = clobber).
- **Wave 5 — Remaining LLM phases** (KRIPA/chain-construct/VYASA/grading) as subagents + structured FindingSchema + custom logic in SubagentStop hooks. Squad-by-squad via marketplace.
- **Wave 6 — DHARMARAJ judge LAST** (longest shadow + disagreement-rate monitor).
- **Wave 7 — Triggers + Routines + optional SessionStore.** June-15 handling throughout: cross threshold → auto-degrade to floor, never hard-stop.

### 7 new gates that lock the mechanism
`GATE-SEAM-CHOKEPOINT · GATE-ADAPTER-PARITY · GATE-ROUTING-VALID · GATE-SHADOW-NO-LEAK · GATE-CREDIT-BUDGET · GATE-DURABILITY-OWNERSHIP · GATE-FAILSOFT`

---

## PILLAR 2 — ASHWATTHAMA, the self-updating capability engine

**One line:** watches official Claude docs → detects quality/speed/credit features → drafts a port-bound adapter on a branch (never mutates prod) → benchmarks credit-budgeted against a golden eval set using DHARMARAJ + the gates → one-tap Telegram approval → feature-flagged, instantly-reversible rollout → auto-rollback on regression.

### Control loop
`WATCH → DETECT → PROPOSE → BENCHMARK → GATE → APPROVE → ADOPT → MONITOR/ROLLBACK`. Autonomy ends at APPROVE for forward changes; the only unattended mutation is ROLLBACK (returns to a previously-approved known-good state, gate-verified).

### The 4 factual corrections the red-team caught by reading live docs
1. **Routines run NO hooks / NO permission prompts** → gates + rollback-verify must run in a LOCAL hook-honoring session, never the cloud routine.
2. **Routines DO draw subscription credit** ("same way interactive sessions do") → no free tier; every step budget-checked; overage disabled (fail-closed).
3. **Green status ≠ success** → rollback trips on real DHARMARAJ/gate measurements, never routine status.
4. **Connectors default ALL-included with writes** → WATCH must explicitly strip connectors (CI-asserted) or it's an exfil channel the network allowlist doesn't cover.

### 13 mandatory guardrails (G1-G13)
Tier-0 invariants (gate in non-routine context; budget assumes routines spend; adopt = healthcheck+validate+atomic-swap+readback; preview = shadow-only). Tier-1 injection containment (two-key trust separation: the LLM that reads untrusted docs never writes code; strip connectors; domain-pin + content-hash). Tier-2 evidence integrity (held-out + rotating + honeypot eval split; mandatory live-canary; statistical gates). Tier-3 human-gate hardening (**the approval card is adversarial to itself** — mandatory independent con line; rate-limit + weekly digest to kill fatigue; two-tap for high-blast-radius; engine-re-fetched source hash; cooling-off for engine self-modification).

### Build phases (read-only first)
Phase 0 truth-up → Phase 1 read-only watchman (zero mutation) → Phase 2 DETECT + trust separation → Phase 3 golden eval harness → **[PAUSE / go-no-go]** → Phases 4-9 PROPOSE/GATE/APPROVE/ADOPT/MONITOR. **Phases 1-3 deliver ~80% of the value (never miss a feature + know if it's actually better) at ~20% of the risk** and are nearly all read-only.

### The honest #1 risk
Prompt injection is **unsolved** (~1% single-shot, ~5-6% after 100 adaptive attempts — Anthropic's own numbers). Containment reduces but doesn't eliminate it; the human tap is the last line, and a fatigued human is the weakest link. That's why propose-only + weekly-digest + adversarial card are non-negotiable.

---

## Consolidated decisions for Jay

**Architecture:**
- A1. Commit to a hard delete-the-old-path deadline per wave (N=7d)? → **REC: YES, in writing before Wave 0.** Without it the strangler never strangles → don't start the full migration, just do Wave 1 standalone.
- A2. If the meter-probe shows SDK-pool billing, proceed (lead on MCP + governor)? → **REC: PROCEED** (quality uplift is real regardless of billing).
- A3. Max5x vs Max20x post-June-15? → **REC: size on data** after the CostGovernor records 2 weeks of real burn; don't provision blind.
- A4. SessionStore now or defer? → **REC: DEFER to Wave 7**, adopt only if the transcript race actually recurs.

**Engine:**
- E1. Autonomy: propose-only vs auto-adopt-low-risk? → **REC: propose-only for ALL ports** (your plan-first rule; #1 catastrophic path is a rubber-stamped poisoned change).
- E2. Approval cadence: real-time vs weekly digest? → **REC: weekly digest** + immediate card only for high-materiality/high-blast-radius (fights fatigue-drip, the top failure mode).
- E3. Engine self-modification of its own safety core? → **REC: permanently manual-only** for gate/budget/eval; recursion allowed only for the WATCH trigger.
- E4. Full loop vs stop at Phase 3? → **REC: build through Phase 3, then pause** and re-decide on evidence.

---

## Recommended sequencing (my honest read)

1. **Do Wave 1 now-ish regardless** — zero-credit MCP verifiers. Standalone net-positive, de-risks June-15, no commitment required.
2. **Then ASHWATTHAMA Phases 1-3** — read-only watcher + classifier + eval harness. ~80% of the "auto-adopt latest features" value, almost all read-only, sails through plan-first.
3. **Only then** decide on the full strangler migration (gated on the A1 deadline commitment) and the engine's adopt loop (Phases 4-9).

This gives you the future-proofing and the self-updating awareness *fast and safe*, and defers the expensive/dangerous self-modifying machinery until the cheap layers have proven their worth.
