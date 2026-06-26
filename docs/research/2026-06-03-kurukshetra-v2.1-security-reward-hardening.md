# Kurukshetra v2.1 — Security & Reward Hardening (baked into the NEW framework)

**Date:** 2026-06-03
**Status:** DESIGN ONLY — amends v1 + v2. **No code changed; no old-code patching.**
**Decision (Jay):** "On the new framework we have to improve this, not old." → these gap-hunt findings are **requirements of the new framework**, not retrofits to `event-bus.js`. The old daemon is being strangled away; hardening it is throwaway work. Each fix lives at a **PORT or GATE** so it's structural (enforced by design), not bolted on.

**Source:** the 2026-06-03 architecture gap-hunt (9-agent workflow, web SOTA + code-verified).
**Core finding being addressed:** the design under-weighted that **pentest/red-team TARGETS are live adversaries** whose HTTP/JS the agents read every run (indirect prompt injection), and that **SANATANA's reward is a soft LLM judge** (Goodhart-able even uneditable). Everything below closes those two classes — cheaply, KISS-disciplined.

> Interim note: the env-inheritance wire (`_buildClaudeSpawnEnv` spreads `...process.env`, verified at event-bus.js:2210/2960) exists on the LIVE daemon until the new AgentRunnerPort/MCP boundary ships and the old spawns are deleted. Accepted as interim risk per Jay; closed structurally below.

---

## A. Runtime injection defense — built INTO the ports (targets are hostile)

The new framework treats every byte read from a target as untrusted adversary input *from day one* (the old one didn't). These are AgentRunnerPort / VerifierPort properties + safety-perimeter policy, enforced by new gates.

| # | Requirement | Where it lives in the new framework | New gate | Effort |
|---|---|---|---|---|
| **A1** | **Env allowlist, never `process.env`.** Every agent/tool invocation gets an explicit allowlisted env object. In the new design verifiers are **MCP servers** — express the scrub at the MCP-server process boundary (and any residual `claude` invocation behind AgentRunnerPort). | AgentRunnerPort + VerifierPort (the single invocation chokepoint) + each MCP server launch | `GATE-ENV-ALLOWLIST` (no `...process.env` at any spawn/MCP boundary) | **S** |
| **A2** | **Egress default-deny for content-touching adapters**, browser-verifier first (it *executes attacker JS* — Sprint B `cross_origin_fetch`). Block link-local (`169.254.169.254`), loopback (your own event-bus/mission-control), RFC1918; allowlist Anthropic API + in-scope hosts. | Safety perimeter as a deterministic netns/nftables policy bound to the VerifierPort browser adapter | `GATE-EGRESS-DENY` (browser adapter cannot reach metadata/loopback/RFC1918) | **S/M** |
| **A3** | **Data-fence + per-action scope re-check.** Fetched adversary content is a **typed untrusted object** the planner never reads as instructions (spotlighting). Re-assert the **existing `matchesScope()`** predicate on **every outbound action**, not just at dispatch — an injected page must not redirect the scanner out-of-scope (CFAA-pivot). | AgentRunnerPort content-ingestion boundary; reuses `squad-policy.matchesScope()` | `GATE-SCOPE-PER-ACTION` | **M** |
| **A4** *(should-later)* | **gVisor isolation for the ~15 content-touching agents only** (pentest/red-team/network + browser-verifier), composing A1+A2, `/root/intel` read-only. **NOT** microVM-per-agent; **NOT** stocks/code-review agents (they read only your own source). Closes your own IronCurtain per-agent-isolation gap. | Per-agent execution profile under AgentRunnerPort | — | M/L |

---

## B. Provenance & audit — built INTO the FindingPort

| # | Requirement | Where | New gate |
|---|---|---|---|
| **B1** | **Provenance stamp** `{framework_git_sha, judge_model_id, system_prompt_sha256, user_prompt_sha256}` on every finding (content-addressed in the trace already written). Makes a disputed shipped CRITICAL reproducible weeks later AND is the **precondition for SANATANA rollback** (can't roll back a prompt change without knowing which findings came from which prompt SHA). | FindingPort (where `validateFinding` already runs) | — |
| **B2** | **`findings-decisions.jsonl`** appended at each fail-soft phase `{taskId, findingId, phase, action, from, to, reason}` (~10 one-line appends). Kills the silent-drop class that burned you twice (Pentest #2 false early-exit). | across the 18 phase adapters | `GATE-FAILSOFT-OBSERVABLE` (a swallowed error MUST emit a decision line) |
| **B3** | **ERROR ≠ EMPTY at the tool boundary.** A crashed tool must never silently equal "found nothing" — that's a false-negative generator in a security tool. | AgentRunnerPort/VerifierPort tool-result handling | (pairs with B2) |

---

## C. SANATANA reward anchoring — BLOCKS self-improvement launch until done

The v2 invariant ("the improver may never edit its judge") is **necessary but not sufficient** — an uneditable but *soft* LLM judge still gets Goodharted. DGM gamed even a *hard* oracle; SANATANA's gate is softer AND its held-out cases are graded by the same judge. Blast radius = auto-evolving a prompt that publishes a **wrong CRITICAL to a live program.**

- **C1 — Anchor fitness on the HARD oracles.** SANATANA's BENCHMARK fitness function is **primarily the deterministic verifiers** (chain-verifier curl-status, browser-verifier Playwright, active-PoC). **DHARMARAJ becomes a secondary signal that can DOWN-WEIGHT but NEVER PROMOTE** a proposal. → new `GATE-REWARD-ORACLE-ANCHORED` in the SANATANA benchmark stage, before the 92 gates. **This blocks SANATANA launch.**
- **C2 — Evidence-anchored judging.** DHARMARAJ must cite an **extractive quote mechanically verified (substring check) to appear in the Phase-3.07 captured response body.** Trivial check, kills hallucinated-evidence promotion.
- **C3** *(should-later)* — **Judge gold-set (50 cases/squad) + drift monitor on every `model_id` change.** This is the answer to "who watches the judge": the human-only artifact is the **gold-set**, not the judge code — and hosted Claude can silently rev under you. Read-only weekly/on-model-change Cohen's-kappa-vs-Jay. Pin the judge as `(judge_model_id, rubric_version, prompt_template_hash)`.
- **C4** *(should-later)* — **`content_source` tag** `{framework | operator | UNTRUSTED-TARGET}` stamped at OBSERVE (free at capture). **UNTRUSTED-derived episodes never auto-promote** to a skill or live-prompt memory (human-tap only) and are firewalled out of skill-induction (defends the real **MemoryGraft** attack, arXiv 2512.16962). Recurrence threshold counts **distinct target origins**, so one adversary can't manufacture recurrence. The content-trust classifier is in the **forbidden zone**.

---

## D. Judge-independence correction (supersedes an existing decision)

- **D1 — Retire the Haiku separate-grader.** Same model family = same self-preference priors (arXiv 2502.01534, 2504.03846); a Haiku judging Opus is a *worse* judge with the *same* bias — **zero real independence**. Replaces the approach in memory `project_separate_grader.md`.
- **D2 — Cross-family `/codex` (OpenAI, already in toolbox) ONLY on CONFIRMED-CRITICAL-about-to-publish** — the one verdict with external blast radius. Plus free prompt-level fixes: both-orderings-consistent on any pairwise judge call, length-aware rubric line. **S effort, ~free.**

---

## E. Cost correction (fixes a v1 error)

- **E1 — Caching is REPURPOSE, not DELETE.** v1's "what gets deleted" list said remove the `--bare` byte-identical-prefix caching — **that's backwards.** Byte-identical prefixes are what *make* prompt caching work; caching is a **41-80% input-cost cut** that matters post-June-15. New-framework prompt construction = `[stable prefix | cache_control breakpoint][volatile tail]`. Plus a **content-hash-keyed recon/artifact cache** (reuse Phase-3.07 snapshots, keyed `target_url + sha256(body+JS)`) so recurring queues (Lenovo/ENBD) don't re-pay LLM recon on unchanged targets. Content-hash, NOT embedding-fuzzy (zero false-hit = the security-correct choice).

---

## Stays SKIP / YAGNI in the new framework too (KISS held the line)

Do **not** build, even in v-next: CaMeL dual-LLM taint interpreter · microVM-per-EVERY-agent · per-page injection-classifier LLM · 3-family judge ensemble on every finding · vector DB / Graphiti / GraphRAG / LLM entity-extraction · Temporal/DBOS/Inngest · OTel-collector/Jaeger/Tempo · learned/bandit router · multi-reviewer/RBAC/quorum · **any fine-tuning/DPO/training infra** (can't train on subscription — a cheap append-only trace collector at most, build nothing). WAL+checkpoint *is* the durability story; 3-table SQLite *is* the entity index; one Jay means RBAC never pays off.

---

## New gates this adds (lock the requirements)
`GATE-ENV-ALLOWLIST · GATE-EGRESS-DENY · GATE-SCOPE-PER-ACTION · GATE-FAILSOFT-OBSERVABLE · GATE-REWARD-ORACLE-ANCHORED · GATE-NO-PROMOTE-UNTRUSTED`

## How this changes the build order (from v1/v2)
- **A1 + A3 + B1 + B2** fold into **Wave 0/1** of the new framework — they're properties of the ports already being built, cheap, and the security foundation. The new AgentRunnerPort/VerifierPort/FindingPort ship *with* the env-allowlist, data-fence, per-action scope, and provenance baked in.
- **A2 (egress-deny)** rides Wave 1 (MCP-verifier migration) since the browser-verifier becomes an MCP adapter there.
- **C1 + C2 (reward anchoring + evidence-anchored judging)** are a **hard launch gate on SANATANA** (v2 build Phase 5) — self-improvement does not go live without them.
- **C3/C4/A4 (gold-set, content-source firewall, gVisor)** are should-later, sequenced before SANATANA may auto-promote anything.
- **D (judge independence) + E (caching)** are near-free corrections, applied wherever Phase 3.9 / prompt construction is touched.

## Bottom line
The new framework was already sound; v2.1 makes it **safe against the one adversary it actually faces every run (the target)** and **honest about its own reward** (hard oracles, not a gameable judge) — without building a single piece of enterprise gold-plating. All of it lives at a port or a gate, so it's enforced by the architecture, not by remembering to be careful.
