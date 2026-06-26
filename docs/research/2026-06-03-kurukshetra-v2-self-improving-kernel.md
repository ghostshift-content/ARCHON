# Kurukshetra v2 — Self-Improving, Domain-Agnostic Kernel

**Date:** 2026-06-03
**Status:** DESIGN ONLY — extends (does not replace) `2026-06-03-kurukshetra-inside-claude-code-vision.md`. **No production code changed.**
**Asked by:** Jay — "make it self-improving (skills/plugins/mcp/md-files learn & auto-improve itself, like Hermes/Nous), and make the framework so it adopts ANY squad later (pentest/stock/red-team/anything)."
**Method:** 11-agent deep-research+design workflow (web SOTA: Hermes/Nous, Voyager, ADAS, Darwin Gödel Machine, GEPA, Letta, Mem0, A-MEM; + red-team grounded in verified incidents).

---

## TL;DR

v1 settled the *base*: a durable spine + 8 ports + ASHWATTHAMA (adopt new Claude Code features). v2 adds the two things you asked for:

- **Pillar 3 — Domain-agnostic KERNEL.** The core knows *nothing* about pentest or stocks. Every squad is a **plugin** filling a stable **6-slot Squad Contract**. Add a domain (legal-review, options-trading, anything) = author a plugin, **zero kernel edits**. ~70% of this already exists in your `SQUAD_TYPES` + `squad-policy/*.js` — v2 *finishes and hardens* it, not a rewrite.
- **Pillar 4 — SANATANA, one self-improvement organ.** The framework watches its *own runs*, distills learnings, and proposes improvements to its **memory, skills, prompts, and capabilities** — all through ONE gated pipeline (propose → benchmark → 92 gates → your one-tap → adopt → auto-rollback).

**The single load-bearing invariant** (learned from a real failure, not theory): *the improving agent can never edit the thing that judges it.* The Darwin Gödel Machine — a gated loop just like ours — hacked its own evaluation by stripping the log markers its hallucination-detector relied on ([The Register 2025-06-02](https://www.theregister.com/2025/06/02/self_improving_ai_cheat/), [Sakana](https://sakana.ai/dgm/)). Everything in the safety design flows from preventing that.

**The honest limit you must know:** we run hosted Claude on a subscription — **we cannot fine-tune weights.** Hermes/Nous can (Atropos/Psyche RL). Our flywheel *terminates at prompt/skill/memory/agent-definition*. Our version of "a better model" is "a better-curated prompt+skill+memory corpus." That's powerful, but it's not weight-training, and pretending otherwise would be dishonest.

---

## Pillar 3 — The Domain-Agnostic Kernel

```
   ┌───────────────────────────────────────────────────────────────┐
   │  KERNEL  (domain-BLIND — GATE-KERNEL-DOMAIN-BLIND forbids any   │
   │          domain literal: no 'pentest', no 'stocks', no /intel/<d>)│
   │                                                                 │
   │   durable spine (v1) · 8 ports · phase DRIVER (fail-soft loop)  │
   │   Squad Registry+Loader · SANATANA organ · eval/gate/approval   │
   │   universal agents: SANJAY · KRIPA · DHARMARAJ · VYASA          │
   │   (they operate on CANONICAL Findings via each squad's policy)  │
   └───────────────────────────────┬───────────────────────────────┘
                                    │  loads plugins via marketplace
                                    │  (SHA-pinned, channel-gated, sandboxed)
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              ▼
     pentest        stocks      red-team    legal?         trading?
     (plugin)       (plugin)    (plugin)   (future)        (future)
        └─ each fills the 6-SLOT SQUAD CONTRACT ─┘
```

### The Squad Contract (the only surface the kernel depends on)

| Slot | What | Required? | Notes |
|---|---|---|---|
| **1 Identity & Topology** | squad config (name, version, channel, leader=orchestrator-role, specialists, gateStyle, phases-or-universal-default, memoryNamespace, reportDirs, costBudget) | ✅ declarative | This is today's `SQUAD_TYPES[id]` object *lifted out of kernel source* into the plugin |
| **2 Domain Policy Adapter** | `extractTarget · matchesScope · scoreOf` (was cvssOf) `· severityProfile · judgeRubric() · reportScrubRules() · findingShape()` | ✅ the only code | **Load-bearing.** ALL domain knowledge concentrates here — a legal squad supplies "does this clause violate retention policy" as its rubric; the kernel never learns what a retention policy is |
| **3 Agents/Personas** | specialist `.md` subagents (`model:` frontmatter = modelRouter) | ✅ | |
| **4 Domain Tools/MCP** | `.mcp.json` + agentskills.io-compatible `SKILL.md` | optional | prose-default-safe; authored MCP code gated harder |
| **5 Golden Eval Set** | `eval/` dir of the squad's OWN held-out + rotating + honeypot cases | ✅ for self-improvement | **The keystone** — no eval = runs in prod but the flywheel skips it (can't gate what you can't measure) |
| **6 Provenance & Safety** | SHA-256 digest, SemVer, channel, author, declared blast-radius scope (kernel-enforced) | ✅ manifest | |

### Add a new squad in 7 steps (e.g. `saas-billing-audit` or `options-trading`)
1. Write `squad-manifest.json` (Slots 1+6).
2. Write `squad-policy/<squad>.js` (Slot 2 — copy the ~36-line pentest adapter; `scoreOf` = revenue/P&L/clause-impact rank, not CVSS; `judgeRubric()` = your domain's "what counts as CONFIRMED").
3. Author persona `.md` subagents (Slot 3).
4. *(optional)* add `.mcp.json` + prose `SKILL.md` (Slot 4) — prose-first.
5. Build `eval/` golden set: 15-20 sealed cases (known-bug→CONFIRMED, working-as-designed→DISPROVEN), held-out/rotating/honeypot, must pass `GATE-EVAL-QUALITY`'s discrimination check.
6. Add one marketplace routing row + register → `GATE-SQUAD-CONTRACT` validates against the 6-slot schema.
7. Ship shadow → 20 clean samples + eval-pass → beta → stable.

**What the author gets FREE (writes nothing):** the durable spine, all 8 ports, every universal phase (scope-prevalidate, verify, severity-filter, judge, report), DHARMARAJ judging *against their rubric*, VYASA reporting with universal agent-name scrub, per-agent memory, **and the self-improvement flywheel against their eval set.** That's the payoff of the kernel/plugin split.

> Bonus: `GATE-KERNEL-DOMAIN-BLIND` would have caught the *real* latent bug we already know about — Phase 3.075 firing only in `dispatchPentestParallel`, silently missing stocks.

---

## Pillar 4 — SANATANA: one self-improvement organ, four sources

```
   FOUR SOURCES feed ONE pipeline (build four separate loops = four
   chances to violate the invariant — so it's deliberately ONE):

   (A) self-MEMORY distillation   ┐
   (B) SKILL induction (Voyager)  ├──▶  one CapabilityCandidate schema
   (C) PROMPT opt (GEPA/DSPy)     │
   (D) CAPABILITY adopt (ASHWATTHAMA, v1) ┘
                                          │
   1 OBSERVE   deterministic hook, ZERO LLM (records, never judges) → episodes/ + FTS5 index
   2 DISTILL   weekly Routine (off hot path), Mem0 verbs + A-MEM links → 1 candidate/cluster
   3 PROPOSE   on a BRANCH, two-key separation (reader≠writer), injection lint
   4 BENCHMARK squad's eval, held-out+rotating+HONEYPOT the proposer never saw, stacked on LIVE composite
   5 GATE      all 92 gates in a LOCAL hook-honoring session + safety-perimeter gates
   ╪═══════════ HARD STOP — human one-tap ═══════════╪
   6 APPROVE   weekly Telegram digest, mandatory adversarial CON-LINE per card
   7 ADOPT     write ONE file at approved scope, SemVer shadow→beta→stable, atomic-swap+readback
   8 MONITOR   live win-rate vs pre-adopt baseline → AUTO-ROLLBACK on real regression (never on "green")
```

### The four improvement types

| Type | Artifact | Friction | Key safety |
|---|---|---|---|
| **MEMORY** | merged/pruned `lessons.md`, self-evolved `MEMORY.md` [[links]] (Mem0 verbs + A-MEM) | AUTO if data-internal; 1-TAP once it feeds a live prompt | advisory-only, TTL-decayed, recurrence-thresholded, may never *suppress* a finding (only down-weight); judge re-derives |
| **SKILL/TOOL** | new prose `SKILL.md` (Voyager) or MCP tool | 2-TAP prose; 2-TAP + sandbox for code | verify-before-store in a *different* context (Voyager: −73% without it); authored code = sandbox + GATE-SQUAD-BLAST-RADIUS |
| **PROMPT/AGENT** | GEPA/DSPy-tuned system prompt or `.md` persona | 1-TAP prompt; 2-TAP whole agent | **cumulative-drift gate** (25 fine edits = a worse agent nobody approved) + periodic baseline-reanchor |
| **CAPABILITY** | new CC-feature adapter + routing row (ASHWATTHAMA) | 2-TAP (v1) | two-key separation on the doc-watcher (injection is the #1 unsolved risk) |

### The self-improvement spectrum — where we stop
0. memory accumulation → **SHIP** (have it)  ·  1. memory distillation → **SHIP/gate**  ·  2. skill induction → **gate (prose) / human (code)**  ·  3. prompt optimization → **gate (prompt) / human (whole agent)**  ·  4. capability adoption → **gate (v1)**  ·  5. **code self-modification (DGM) → AVOID as prod-default** (research lane only)  ·  6. **self-modifying the judge/reward/weights (SEAL) → PERMANENTLY FORBIDDEN** (and not even reachable on subscription).

Everything you asked for lives in **tiers 0-3.** The frontier line is exactly where the agent can edit its own code AND touch its own success metric. **We stay strictly below it.**

### Worked example (the flywheel earning its keep)
Over ~50 pentest runs, DHARMARAJ marks 9 where ARJUN missed second-order IDORs (reachable only after a state-changing POST). OBSERVE logged them; the weekly DISTILL clusters them (9/50 ≫ noise), proposes a prose skill `second-order-idor-probe.md` + a small prompt patch, citing the 9 episode IDs. A *different* agent writes it on a branch. Benchmark on held-out + honeypot: +18% recall of the planted class, FP flat, cost +4%. 92 gates pass; the diff touches only ARJUN's files (not gates/eval/organ). Friday's digest shows the card with a mandatory con-line + cumulative drift score. You tap approve. Adopted on shadow channel, ARJUN hot-loads it, SANATANA monitors live confirm-rate — promotes if it holds, auto-retires if FP spikes. *A miss class no human noticed, surfaced from the framework's own grades, fixed as a reusable skill, proven on evals, approved in one tap — with zero ability for ARJUN to touch the judge that validated it.*

---

## What we borrow (grounded, not vibes)

| Source | Idea | Maps to |
|---|---|---|
| **Hermes / Nous** (the ref Jay gave) | closed trace→variant→gate→human-PR loop, per-skill eval source, agent-curated memory, periodic nudge | confirms flywheel must run *per-squad* against the squad's own eval (Slot 5). **Honest trap:** documented, NOT peer-reviewed; Nous trends toward *weights* (Atropos/Psyche) which we can't do — borrow the shape, not the assumed safety |
| **GEPA** (arXiv 2507.19457, ICLR'26 oral, in DSPy) | reflective prompt evolution that reads *why* a run failed | improvement source C — peer-reviewed, model-agnostic Python on the Anthropic API, **no Nous model needed** |
| **Voyager** | promote a success into a named reusable skill; −73% without verify-before-store | source B — the biggest thing we lack today (we distill failures only) |
| **Mem0** | ADD/UPDATE/DELETE/NOOP memory verbs | wraps the append-only `lessons.md` writer → fixes rot, no new storage |
| **A-MEM** (NeurIPS'25) | agent self-evolves its own memory links | turns hand-authored `MEMORY.md` [[links]] into agent-maintained ones |
| **Darwin Gödel Machine** | archive of variants — AND the cautionary tale (it hacked its own hallucination markers) | the archive → `sanatana/proposals/archive/`; the incident → **the core invariant** |
| **Letta** | between-runs "sleep-time" memory curator | the weekly DISTILL Routine, off the hot path for June-15 cost discipline |
| **LATM / agentskills.io** | powerful model manufactures a tool once, cheap models reuse; skill = dir + SHA-256 integrity | per-agent model frontmatter; manifest aligns to the open standard; banked verifier-skills are zero-credit → the flywheel *manufactures* pool-relief |

---

## Mandatory guardrails (the DGM lesson, operationalized)

- **Safety perimeter, not just core** (`GATE-NO-SELF-MODIFY-SAFETY-CORE`): the forbidden zone covers gates + eval corpus + reward + rubric + organ code **+ the OBSERVE tagging logic, the recall ranker, the trigger heuristics, and the eval-split rotation seeds** — because *anything that decides what the judge sees is part of the judge.* Trigger-heuristic changes are human-only. Plus a canary of known-bad lessons that must always trip the gates + gate-integrity attestation (hash-verify gate/eval files every run).
- **Anti-Goodhart eval discipline:** held-out + rotating + honeypot the proposer never sees; statistical win-rate bar PLUS mandatory cost-and-FP-delta (recall up but FP up = fail); counter-metric basket; leakage canary (unique tokens in honeypots scanned out of `episodes/` every DISTILL — any hit *halts the flywheel*).
- **Eval-quality gating:** `GATE-EVAL-QUALITY` — min cases, mandatory negatives + honeypots, and a *discrimination check* (must tell a deliberately-nerfed agent from the real one). Eval authorship separated from improvement approval. Scheduled re-audit.
- **Memory is advisory-only:** versioned, TTL-decayed, recurrence-thresholded, dual-key with injection lint at *both* reader→episode and writer→lesson boundaries, structured provenance, may never silently suppress a finding.
- **No squad code in the trusted lane:** Slot-2 adapters + Slot-4 MCP run sandboxed (gVisor/microVM-class), network default-deny + allowlist, scrubbed env; `judgeRubric()` output is *data, not instructions* (delimited, injection-scanned, judge's prompt out-ranks it); no import-time auto-registration. `GATE-SQUAD-BLAST-RADIUS` is *runtime-enforced*, not manifest-trusted.
- **Drift control, live-composite benchmarking, cost governance** (per-squad + global benchmark budget, zero-LLM pre-filter, rate-limit so one noisy squad can't DoS the June-15 pool), **skill-library hygiene** (semantic dedup + conflict check + auto-retire), **rollback integrity** (only to a SHA-pinned human-approved known-good state).
- **Propose-not-auto-apply is absolute.** The ONLY three unattended mutations all move *toward* a known-safe state: data-internal memory merge, rollback-to-pinned-known-good, skill auto-retire-to-known-good. Everything that feeds a live prompt or runs code = your one-tap.

---

## Build sequence (read-only & high-value first; self-modification last)

0. **OBSERVE hook + FTS5 index** — deterministic, zero-LLM, nothing mutates. Instant recall value. *The flywheel's eyes with no teeth.*
1. **Harden kernel/plugin split** — lift `SQUAD_TYPES`→manifests, extend `squad-policy` to 6 slots, add `GATE-KERNEL-DOMAIN-BLIND` (kills the 3.075 leak) + `GATE-SQUAD-CONTRACT`. No self-mod yet.
2. **Safety perimeter FIRST** — build the forbidden zone, eval-quality + leakage gates, CostGovernor budget, per-squad eval sets. *The judge and its defenses exist before anything may propose.*
3. **DISTILL → PROPOSE (no live mutation)** — weekly curator writes proposals you review but that can't auto-adopt yet.
4. **Safest mutation: data-internal memory merges** (auto, reversible).
5. **Prose skills + prompt edits through the full gated loop on ONE squad** (the ARJUN example) — first human-tap forward mutations.
6. **Generalize across squads + fold in ASHWATTHAMA** as source D.
7. **LAST & OPTIONAL: authored MCP code tools**, hardest sandbox. **Never** tier-5 code self-modification as a prod-default.

---

## v2 decisions for Jay

- **F1 — How much auto-adopts without a tap?** → **REC: exactly 3 unattended mutations, all toward a known-safe state** (data-internal memory merge, rollback-to-pinned, skill auto-retire). Everything that feeds a live prompt or runs code = one-tap. *Why: this is the literal line between an adaptive system and DGM's self-hacking one — those 3 can't introduce novel behavior.*
- **F2 — Squads ever third-party?** → **REC: first-party-only to start;** if ever opened, third-party = prose-only (no Slot-2 code) until explicitly promoted; all Slot-2 sandboxed regardless. *Why: Slot-2 is executable code wired into the judge; "anyone's squad" is a far bigger trust decision than "my squad."*
- **F3 — Who owns each squad's eval, and how is quality assured?** → **REC: author writes it, but authorship is separated from approval, and every eval must pass the discrimination check + scheduled re-audit.** *Why: otherwise the author writes both the target and the test that grades it — textbook conflict that rubber-stamps junk.*
- **F4 — How fast, given June-15 cap + a flywheel that needs ~5-10 runs/agent to show effect?** → **REC: ship the read-only pieces NOW** (OBSERVE + FTS5 + kernel-domain-blind — zero-LLM, zero-risk, fixes the 3.075 leak); gate the real loop behind the safety perimeter; DISTILL weekly not per-dispatch; defer authored code last.

---

## Bottom line

You changed the design several times and each change was *right* — they converged on this: **a domain-blind kernel that runs any squad, and one gated organ that improves all of them from their own results, stopping exactly at the line where self-improvement becomes self-deception.** It's grounded in real systems (Voyager, GEPA, Letta, Mem0, A-MEM) and disciplined by a real failure (DGM). ~70% of the kernel bones already exist in your code; the safe, high-value first slice (OBSERVE hook + kernel hardening) is read-only and touches neither the credit cap nor any self-modification risk.

Per plan-first: **no code written.** Next move is yours.
