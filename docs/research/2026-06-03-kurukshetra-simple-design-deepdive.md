# Kurukshetra — The Simple Design, Explained (deep dive)

**Date:** 2026-06-03
**Status:** DESIGN ONLY. **Validated against mid-2026 SOTA** (4 independent research passes + Anthropic's own dynamic-workflows article, June 3). **No code changed.**
**Verdict up front:** the design is **2026-correct, dead-center of consensus**. You are wearing **exactly one 2024 garment** — raw `claude -p` stdout-parsing. Change that one thing, add a trace clause, and you're current.

This is the deeper look at the 5 ideas, with the real shapes (so the simple story stays true at build time).

---

## The 5 ideas (final naming)
1. **SPINE** — always-on; owns state, time, **and the run trace**; runs no AI.
2. **PORTS** — ~5 stable sockets; swap what's behind one without touching the rest. *(future-proofing)*
3. **SQUADS = plugins** — a domain is a folder. *(add anything)*
4. **THE LEARNING LOOP** — improves itself from its own runs, gated by your tap. *(self-improving)*
5. **TWO RULES** — it can't grade itself; every target is hostile. *(quality + safety)*

*(Trace folded into the SPINE to keep it at 5 — the learning loop can't improve what it can't see, so the trace is load-bearing and now named. Cost is deliberately NOT a 6th idea — none of OpenAI/LangGraph/CrewAI/ADK elevate it; it's a spine accounting field + a budget cap, not a pillar.)*

---

## Idea 1 — The THIN Spine (state · time · trace)

```
   triggers ─▶ ┌──────────────────────────────────────────────┐
   cron        │  SPINE  (PM2, always on, ZERO AI, ~hundreds   │
   Telegram    │         of lines — not 10k)                   │
   file-watch  │                                              │
               │  owns:  durable queue (WAL) · checkpoints ·   │
               │         locks · cancel · credit ledger ·      │
               │         MEMORY of record · THE RUN TRACE      │
               │                                              │
               │  does:  launch a Claude session that runs a   │
               │         DYNAMIC WORKFLOW for the dispatch ·   │
               │         watchdog → relaunch (resumeFromRunId) │
               └──────────────────────────────────────────────┘
```

**What changed from the old framework:** the spine no longer *runs* a 10k-line 18-phase `claude -p` pipeline. It **launches a dynamic workflow** and supervises it. The orchestration moved into the native workflow (next sections). The spine shrinks to a launcher + durable store + watchdog.

**Why the spine still exists (honest):** dynamic workflows resume *when a session is resumed* — they are **not** a 24/7 daemon by themselves. Something must trigger, launch, relaunch, and hold cross-session state for autonomous operation. That's the irreducible spine. Validated as the 2026 consensus ("12-Factor Agents": own your control flow + stateless reducer; Anthropic "Building Effective Agents": orchestrator-workers).

---

## Idea 2 — The PORTS (now bound to native primitives)

| Port | What it does | What's behind it NOW (native) | Note |
|---|---|---|---|
| **run-agent** | run one agent turn | **Claude Agent SDK `query()`** — structured JSON stream, session resume/fork, hooks | ⚠️ **THE one modernization** — replaces raw `claude -p` + stdout-parsing. Keeps Max-subscription auth (SDK wraps the bundled CLI). Kills your recurring "bare `await fn()` silently drops the return" bug class. |
| **check-result** | verify a finding | **adversarial-verify** subagent inside the workflow + deterministic MCP verifiers (curl/Playwright) | Native workflow pattern; this is Anthropic's fix for *self-preferential bias* |
| **remember** | read/write memory | **native memory-tool contract** (`view/create/str_replace/...` over `/memories`) **on top of your md files** | Keep md/JSON as the *storage*; adopt the standard *surface*. **Do NOT add a vector DB** — Anthropic chose filesystem over vectors; md-files are now the native idiom, not a hack. |
| **report** | publish the result | subagent + agent-name scrub → Telegram outbox | unchanged; scrub stays custom |
| **get-triggered** | start work | cron / Telegram / file-watch in the spine; cloud Routine as a secondary | unchanged |

*(CostGovernor = a meter inside the spine, not a port. "Finding" = a data shape, not a port. "Orchestrator" = the spine + the workflow. That's how 8 became 5.)*

---

## Idea 3 — A Squad is a FOLDER (the real shape, reconciled)

Teaching grain = "agents + rules + tests." The honest build-time shape is a standard Claude Code plugin:

```
   squads/pentest/
   ├── .claude-plugin/plugin.json     ← manifest: name, version, channel, SHA
   ├── squad-manifest.json            ← identity + topology (leader, specialists, phases)
   ├── squad-policy.js                ← the RULES (the only required code):
   │      extractTarget · matchesScope · scoreOf · judgeRubric() · reportScrub()
   ├── agents/                        ← the AGENTS: ARJUN.md, BHEEM.md, KARNA.md …
   │      (each .md: model + effort frontmatter + system prompt)
   ├── skills/                        ← banked prose SKILL.md (Voyager-style)
   ├── hooks/                         ← gate/scrub hook points
   ├── .mcp.json                      ← domain MCP tools (optional)
   └── eval/                          ← the TESTS: sealed golden cases + honeypots
```

Drop this folder in → the spine's Squad Loader (SHA-pinned, sandboxed) registers it, and **everything else works for it for free**: the workflow orchestration, all verification, judging *against this folder's rubric*, reporting, memory, and the learning loop *against this folder's eval set*. Adding `stocks` or `legal-review` or `trading` = author this folder, zero kernel edits.

---

## Idea 4 — One DISPATCH as an actual Dynamic Workflow (the killer view)

The old 18-phase `claude -p` pipeline becomes a native workflow built from Anthropic's named patterns:

```
   workflow(dispatch):                                    ← pattern (Anthropic's names)
     targets = recon(dispatch)                            ── classify-and-route
     findings = parallel( specialists.map(s =>            ── FAN-OUT-and-synthesize
                  agent(s, targets) ) )                      (each fresh context = no cross-contamination)
     for each finding:                                    ── ADVERSARIAL-VERIFICATION
        verdict = agent("refute this finding", finding)      (separate agent ≠ self-grading → fixes self-bias)
        + deterministic MCP curl/Playwright check (hard oracle)
     loop until no new findings                           ── LOOP-until-done (fixes "stopped at 20 of 50")
     # untrusted target content is QUARANTINED:           ── QUARANTINE
     #   the agent that READ the hostile page cannot          (Anthropic's named injection defense
     #   take a high-privilege action; a separate agent does   = our "targets are hostile" rule)
     report = synthesize(verified findings) ; scrub ; publish
```

Every line maps to a phase you already have — but you get fan-out, adversarial verification, loop-until-done, quarantine, and model-routing **native**, instead of plumbing them in `claude -p`. **Caveat:** workflows use more tokens — set a `budget` cap and reserve them for genuinely-parallel/adversarial dispatch (pentest is exactly that), not trivial tasks. Matters for the June-15 pool.

---

## Idea 5 — One trip through the LEARNING LOOP (concrete) + 2026 hardening

Over ~50 pentest runs, the judge marks 9 where ARJUN missed second-order IDORs. The loop:
**OBSERVE** (zero-LLM hook → episodes + trace) → **DISTILL** (weekly, clusters the 9, proposes a prose skill `second-order-idor-probe.md`) → **PROPOSE** (different agent writes it on a branch) → **BENCHMARK** (squad eval + honeypots, judged by a *separate* context, +18% recall, FP flat) → **GATE** (92 build-tests; diff can't touch the judge) → **APPROVE** (your one tap, weekly digest, con-line) → **ADOPT** (shadow→beta→stable) → **MONITOR** (auto-rollback if it regresses).

**New 2026 hardening to fold into the gate** (research proved verifier-gated loops still get gamed):
- **Isomorphic Perturbation Testing** — also run a *paraphrased* copy of the eval; if the gain shows only on the literal eval, it gamed the judge → reject. (arXiv 2604.15149) *Highest-value add.*
- **Judge master-key hardening** — strings like `"Thought process:"` or a blank line drove LLM-judge false-positives to 66-80%; since the judge reads attacker-influenced finding text, add those to the judge's negative test set. (arXiv 2507.08794)

---

## The TWO RULES, concretely (both are native workflow patterns)
- **It can't grade itself** → adversarial-verification pattern: a *separate* agent (and a deterministic oracle) checks each finding. Anthropic shipped this as **Outcomes** (self-grading via a separate evaluator) — you encoded the invariant a year early.
- **Every target is hostile** → quarantine pattern: agents that read untrusted target content are barred from high-privilege actions. Anthropic recommends exactly this. Plus v2.1's env-allowlist + egress-deny + per-action scope re-check.

---

## Are we outdated? (the direct answer to Jay)

**No — with exactly one exception.** Four independent passes agree: the spine-owns-state / LLM-is-stateless split is the literal 2026 consensus; PM2 durability is correct for one box (**Temporal/DBOS = overkill, don't touch**); md-file memory is now the **native** idiom (no vector DB); and both safety rules were shipped by Anthropic itself (Outcomes + Guardrails) — you were a year early.

**The one outdated thing:** raw `claude -p` + stdout-parsing → **Agent SDK `query()`** behind the run-agent port (keeps subscription auth, kills the silent-drop bug class).

**Three native things now worth adopting:** the memory tool (delete bespoke md-writes, keep files as backend) · Dreaming/Auto-Dream *when it hits GA on Max* (the memory-hygiene half of the loop — until then your hand-rolled loop is the right shape, lose nothing) · native lifecycle hooks (move scrub + gates to hook points).

**The actual emergency (not architecture):** the **June-15 capped credit pool** — your daemon's programmatic calls start drawing a separate $100-200/mo pool that **silently stops when drained**. Instrument usage and decide overflow billing **this week**. Also fix the hardcoded model strings (4 files) — under the cap they're unmetered Opus spend.

**Bottom line:** 2026-appropriate design wearing one 2024 garment. Change the garment (`claude -p` → SDK), add the trace clause, harden the eval gate (IPT + master-key), handle June-15 — and the framework is current, simple, and future-proof.
