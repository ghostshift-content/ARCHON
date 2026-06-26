# Kurukshetra — THE FRAMEWORK (final consolidated design)

**Date:** 2026-06-03 · **Status:** DESIGN, validated against mid-2026 SOTA + Anthropic's own June-3 guidance · **No code changed.**
This is the single canonical design. It supersedes nothing in detail (v1/v2/v2.1/deep-dive remain the appendices) — it *unifies* them into one coherent, current, buildable framework.

> **What it is, in one breath:** a thin always-on spine launches native Claude Code dynamic workflows that run domain "squad" plugins; the framework watches its own runs and continuously, *safely*, improves its own memory, skills, and prompts — gated by your one tap — while treating every target as hostile and never letting the part that improves grade itself.

---

## The 5 ideas (the entire mental model)

```
   triggers ─▶ ┌──────────────────────────────────────────────┐
               │  ① THE SPINE  (thin · always-on · NO AI)      │
               │     owns: queue · memory · state · TRACE      │
               │     launches an INTERACTIVE Claude session →  │  ← billing-smart (exempt pool)
               └───────────────────┬──────────────────────────┘
                  through ② 5 PORTS │ (swap what's behind one, never the spine)
                                    ▼
               ┌──────────────────────────────────────────────┐
               │  a DYNAMIC WORKFLOW runs the dispatch         │  ← native orchestration, not claude -p
               │  fan-out · adversarial-verify · loop · quarantine│
               └───────────────────┬──────────────────────────┘
                       uses ③ SQUAD │ plugin (agents + rules + tests)  ← add ANY domain
                                    ▼
                     result + grade + TRACE ──▶ memory
                                    │
                                    ▼
               ┌──────────────────────────────────────────────┐
               │  ④ THE LEARNING LOOP (auto-improve, gated)    │
               │  observe→distill→propose→benchmark→YOUR TAP→  │
               │  adopt→auto-rollback   improves memory/skills/│
               │  prompts/capabilities                         │
               │  ⑤ RULES: can't grade itself · targets hostile│
               └───────────────────┬──────────────────────────┘
                                    └──▶ better squads next run
```

1. **SPINE** — small, always-on, owns durable state + time + the run trace, runs no AI, launches+supervises the workflow.
2. **PORTS** — ~5 stable sockets; swap what's behind one without touching anything else. **= future-proofing.**
3. **SQUADS = plugins** — a domain is a folder (agents + rules + tests). **= add anything.**
4. **LEARNING LOOP** — improves itself from its own runs, one human tap. **= auto-improve.**
5. **TWO RULES** — can't grade itself; every target is hostile. **= quality + safety.**

---

## ① THE SPINE (thin, durable, billing-smart)

A few-hundred-line always-on program (PM2). It owns what must survive a crash and what no single Claude session can: the **durable queue (WAL)**, **checkpoints**, **locks/cancel**, the **memory of record**, the **credit ledger**, and the **run trace**. It runs **zero AI**. Its job each dispatch: **launch an interactive Claude session that runs the workflow**, watchdog it, relaunch on crash (`resumeFromRunId`).

- **Why it can't dissolve:** dynamic workflows resume only when a session resumes — they are not a 24/7 daemon. Something must trigger, launch, relaunch, and hold cross-session state. That's the spine. *(2026 consensus: 12-Factor Agents, Anthropic "Building Effective Agents".)*
- **Billing-smart (June-15):** it prefers **interactive sessions** (exempt from the new capped pool) over headless `claude -p`/SDK (capped pool), and routes low-frequency scheduled work to **Routines/Co-work** (interactive pool). Which path bills how is **measured, not assumed** (the meter-probe).
- **Future-watch:** if Anthropic ships a native always-on agent ("Chyros", leaked), it may replace the spine's launcher role — so the spine stays thin and swappable, never heavy.

## ② THE PORTS (5 sockets, native bindings)

| Port | Behind it now (native) | Note |
|---|---|---|
| **run-agent** | **Agent SDK `query()`** (structured stream, session resume, subscription auth) | replaces raw `claude -p` + stdout-parsing — the one modernization; kills the silent-drop bug class |
| **check-result** | adversarial-verify subagent **+** deterministic MCP oracles (curl/Playwright/active-PoC) | the hard oracles, not opinion |
| **remember** | **native memory-tool contract** over your md files | md-files are the *native* idiom now — **no vector DB** |
| **report** | subagent + agent-name scrub → Telegram outbox | scrub stays custom |
| **get-triggered** | cron/Telegram/file-watch (local) + **Routines** (cloud, batch) | Routines = billing-smart for scheduled work |

**Future-proof mechanism:** domain code speaks only the port language; each Claude Code primitive is an *adapter* behind a port, picked by capability-detection with a **floor adapter that never fails to select**. A new Claude feature = **one new adapter + one routing row + one gate**, never a rewrite. *(Workflows/Routines are research-preview → the adapter seam absorbs API churn.)*

## ③ SQUADS = PLUGINS (add any domain, zero kernel edits)

A squad is a standard Claude Code plugin folder:

```
   squads/<domain>/
   ├── squad-manifest.json   identity + topology (leader, specialists, phases)
   ├── squad-policy.js       THE RULES (only required code): extractTarget · matchesScope ·
   │                         scoreOf · judgeRubric() · reportScrub()
   ├── agents/*.md           the AGENTS (model+effort frontmatter + prompt)
   ├── skills/*.md           banked reusable skills (grow over time)
   ├── hooks/ + .mcp.json     gate/scrub points + domain tools
   └── eval/                 the TESTS: sealed golden cases + honeypots
```

Drop it in → the **domain-blind kernel** (`GATE-KERNEL-DOMAIN-BLIND` forbids any domain literal in core) registers it and runs the universal phases for it via the policy adapter. **Free for every squad:** the spine, all ports, the workflow orchestration, verification, judging *against that squad's rubric*, reporting+scrub, memory, **and the learning loop against that squad's eval set**. Adding pentest / stocks / red-team / legal-review / trading = author this folder. ~70% already exists in `SQUAD_TYPES` + `squad-policy/*.js` — v2 *finishes* it.

## ④ THE LEARNING LOOP — the auto-improve engine

One gated pipeline turns the framework's own runs into better squads. Four things it can improve, **all through one loop**:

| Improves | From | Auto or your tap? |
|---|---|---|
| **MEMORY** (md lessons + links) | its own run grades | AUTO if data-internal; **your tap** once it feeds a live prompt |
| **SKILL** (banked SKILL.md) | recurring CONFIRMED wins (Voyager-style) | **your tap** (2-tap for code) |
| **PROMPT** (agent .md) | recurring misses (GEPA/DSPy-style) | **your tap** |
| **CAPABILITY** (new CC feature adapter) | new Claude releases | **your tap** |

**The 8 stages:** `OBSERVE` (zero-LLM hook → episodes+trace) → `DISTILL` (weekly, off the hot path) → `PROPOSE` (on a branch, by a *different* agent than read the data) → `BENCHMARK` (the squad's eval, held-out + honeypot, judged by a *separate* context) → `GATE` (all build-tests; the diff may not touch the judge) → **`APPROVE` (your one tap, weekly digest, mandatory con-line)** → `ADOPT` (shadow→beta→stable) → `MONITOR` (auto-rollback on real regression).

**What auto-improves WITHOUT you (honest line):** exactly **three** moves, all toward a known-safe state — data-internal memory merge, rollback-to-pinned-known-good, skill auto-retire-to-known-good. **Everything that feeds a live prompt or runs code waits for your tap.** That's the literal line between *adaptive* and *self-hacking*.

**2026 hardening folded into the gate** (verifier-gated loops still get gamed):
- **Isomorphic Perturbation Testing** — also benchmark a *paraphrased* eval; gain only on the literal eval = it gamed the judge → reject. *(guards the self-improvement benchmark from gaming — it does NOT touch a live dispatch; zero effect on per-run output quality.)*
- **Judge master-key hardening** — strings like `"Thought process:"` flip LLM judges to 66-80% false-positive; add them to the judge's negative set.
- **Evidence-anchored judging** — the judge must cite a quote *mechanically verified* in the captured response body.

*Validation + correction: Anthropic shipped "Outcomes" (separate-evaluator self-grading) and **"Dreaming" (memory self-curation — shipped 2026-05-06)**, which now do ~70% of this natively. An earlier draft called our design "a year early" — that was **wrong; Dreaming has already shipped.** Adopt Dreaming behind the `remember` port instead of rebuilding the memory lane; keep only the pieces demonstrably stricter than theirs (the oracle-anchored reward is one).*

## ⑤ THE TWO RULES (quality + safety, concretely)

- **It can't grade itself** → a *separate* agent + a *deterministic* oracle verify every finding. The improver is **structurally barred** from editing the judge/eval/reward/trace/trigger-heuristics (the "safety perimeter"). The Darwin Gödel Machine proved a self-improver games even a *hard* oracle — so reward is **anchored on the deterministic verifiers**, and the LLM judge can only *down-weight, never promote*.
- **Every target is hostile** → your agents read attacker-controlled HTTP/JS, so: **env-allowlist** at every invocation (never the daemon env), **egress default-deny** for the browser-verifier (it runs attacker JS — no metadata/loopback/RFC1918), **data-fence** fetched content (it's data the planner never obeys), **re-check scope on every outbound action** (not just dispatch), and **quarantine** (the agent that read the hostile page can't take a high-privilege action). *(All = Anthropic's named "quarantine" pattern + OWASP discipline.)*

---

## How one dispatch actually runs (the workflow)

```
   workflow(dispatch):
     targets  = recon(dispatch)                       — classify-and-route
     findings = parallel(specialists → run-agent)     — fan-out (fresh context each, no cross-talk)
     for each finding:                                — adversarial-verification
        separate agent tries to REFUTE it
        + deterministic curl/Playwright/active-PoC     — the HARD oracle (reward anchor)
     loop until no new findings                       — loop-until-done (no silent early-exit)
     QUARANTINE untrusted content from privileged acts — hostile-target rule
     synthesize verified findings → scrub → publish
     write result + grade + trace → memory            — feeds the learning loop
```

Your 18-phase pipeline *becomes* this — fan-out, adversarial-verify, loop, quarantine, model-routing, all **native**. Set a `budget` cap (workflows use more tokens; matters for June-15).

## Quality, end to end (the "great quality" story)
Be precise about what touches a **live finding** vs what gates **self-improvement proposals** (an independent review caught the earlier "five layers each run" framing as conflation):

**3 layers touch a live finding** (mostly already in production): **deterministic oracles** (curl/Playwright — can't hallucinate) → **independent verifier** (KRIPA — *fresh context, not a different model; removes priming, not shared priors*) → **calibrated judge** (DHARMARAJ, evidence-anchored; cross-family `/codex` on CRITICAL-publish only; *retire the same-family Haiku grader, it bought no real independence*). Then **your tap** before anything ships to a live program.

**2 layers gate self-improvement only, never a live dispatch:** the per-squad **eval gate + IPT + honeypots**.

**⚠️ Honest risk (a real gap for a security tool):** those live filters are all *down-weight-only* — oracle-can't-confirm, KRIPA-skeptical, judge-needs-a-quote, severity-cap — with nothing that promotes. They compound toward **suppression**: a genuine business-logic CRITICAL with no quotable string and no oracle replay can be silently dropped to Low. The counterweight (suppression ledger + manual-verify queue + recall measurement) is specified in "Honest scope & corrections" below — **without it, this is a recall regression dressed as a precision win.**

## Cost / billing model (June-15, 12 days out)
The capped pool ($100-200/mo, hard-stop) hits **programmatic** calls (`claude -p`, SDK); **interactive** Claude Code is exempt. Strategy: **measure first** (7-day usage ledger + the interactive-vs-capped meter-probe), prefer **interactive sessions** for bulk work and **Routines/Co-work** for scheduled batch, hard-cap the learning-loop's benchmark spend, and fix the 4 hardcoded-model-string files (unmetered Opus under the cap). The meter-probe result decides the framework's entire cost future.

## Validated 2026-current · NOT building (KISS)
**Right, keep:** spine/stateless split · PM2 durability · md-file memory · the two rules · the gated loop · squads-as-plugins · 5-idea grain. **Don't build (YAGNI/harmful on one box):** Temporal/DBOS · microVMs-per-agent · vector DBs/GraphRAG · Agent Teams (resurrects race bugs) · Managed-Agents API (wrong cost model) · eval-platform products · RBAC · any fine-tuning infra.

## The build path (safe + high-value first, dangerous last)
0. **Measure** — 7-day usage ledger + meter-probe (June-15 data). *(do now)*
1. **AgentRunner port + SDK adapter** — kill the silent-drop bug, set up the first real port, env-allowlisted. *(the modernization plan)*
2. **Wave-1 MCP verifiers** — move deterministic checks to zero-credit MCP tools.
3. **Kernel domain-blind + squad contract** — finish the ~70% that exists; auto-catches the 3.075 leak.
4. **Safety perimeter + per-squad eval sets** — build the judge and its armor before any self-improvement.
5. **OBSERVE → learning loop, prose+memory only, one squad** — first real auto-improvement, gated.
6. **Generalize across squads + fold in capability-adoption.**
7. **LAST/optional:** authored MCP code tools (hardest sandbox). **Never** autonomous self-code-rewrite.

## The few decisions that are yours
- Auto-adopt stays the **3 safe moves only** (rest = your tap) — recommended yes.
- Squads **first-party only** to start — recommended yes.
- Eval **authored by squad but authorship ≠ approval** + discrimination check — recommended yes.
- Move scheduled work to **Routines** *after* the measurement says it's needed — data-driven.

---

## Honest scope & corrections (independent review, 2026-06-03)
A fresh-eyes independent review found both headline claims pitched one notch high. The design is sound; the framing was corrected. Full verdict: `2026-06-03-kurukshetra-independent-review.md`.

**Auto-update is an auto-WATCHER, not an auto-updater.** None of the adapter-authoring machinery is built, and auto-writing a correct adapter for a feature that shipped after the model's training cutoff is ~10-25% reliable — and the design's own "never autonomous self-rewrite" rule forbids adopting the high-value features (Dynamic Workflows, etc.) anyway. So:
- **Build only the read-only watcher** — a weekly changelog→Telegram digest (~1 day, ~80% of the value, near-zero risk).
- Make it **also alarm on break-detection** — when a primitive you *depend on* changes under you (the `workflow`→`ultracode` trigger-rename class is higher-frequency and higher-blast-radius than adopting-new).
- **Write adapters by hand** behind the existing port (the ports seam already makes that one-file + one-row + one-gate). Keep the seam; skip the auto-authoring engine + its injection attack surface.
- **Adopt Anthropic's native Dreaming** (shipped 2026-05-06) behind the `remember` port instead of rebuilding the memory lane.

**False-negative counterweight (NEW — the review's key safety fix for a security tool).** The live verification floor is four *down-weight-only* filters with nothing that promotes → they compound toward suppression, and a real CRITICAL with no quotable string + no oracle replay can be silently dropped. Counterweight:
1. **Suppression ledger** (`GATE-SUPPRESSION-VISIBLE`): every down-weight/drop of a High/Critical is logged `{finding, which-filter-fired, missing-evidence}` — **false-negatives become visible, never silent.**
2. **Manual-verify queue**: a *high-conviction / low-machine-evidence* finding is **routed to human review, not auto-dropped to Low.** The human tap becomes the promotion counterweight the stack otherwise lacks.
3. **Recall measurement**: once real golden-bug/honeypot fixtures exist (today's 40 "eval" dirs are *rubric checklists, not recall fixtures*), track how often the stack suppresses a *planted real bug*.

**The single highest-leverage move — make quality measurable.** Define ONE quality metric of record per squad (oracle-confirmed precision + known-class recall + FP-delta), capture a **baseline on today's framework NOW** (before any self-improvement ships), and write it to `quality.json`. Every quality number in these docs today is a *fictional worked example*; this converts "improves quality" from a story into a number you can watch.

**Treat the self-improvement loop as a long bet**, not this quarter's lever — on your low volume it needs ~9 recurring misses to fire (a logarithm, not a hockey stick). The immediately-valuable, low-risk pieces are: the read-only watcher, the suppression ledger, the quality baseline, and `GATE-FAILSOFT-OBSERVABLE` (loud drops).

## v-next refinements (competitive sweep, 2026-06-03)
An independent sweep of all agent frameworks + the "Agentic OS" landscape found Kurukshetra **best-in-class to ahead** on the two axes that decide it (oracle-anchored verification quality; ports/adapters future-proofing). The honest work is *subtraction* — stop hand-rolling what Claude now ships natively — plus two real quality gaps. Full verdict: `2026-06-03-kurukshetra-competitive-sweep.md`.

**Use native, stop reinventing (net-simpler):**
- **`/goal` for the convergence loop** — "loop until no new findings" IS native `/goal`'s worker+separate-evaluator contract (CC 2.1.139). Express it via `/goal` with **our deterministic oracle as the done-condition** (worker surfaces oracle results into the transcript; the evaluator reads them — it can't call tools itself). **Delete the bespoke `early-exit-decision.js` heuristic.** `/goal` (depth) and workflows (width) are *orthogonal axes* — `/goal` composes with workflows, it isn't "above" them.
- **Dreaming behind the `remember` port** (shipped 2026-05-06) — delete most custom OBSERVE→DISTILL→PROPOSE memory code; keep only the oracle-anchored reward (stricter than Dreaming's frequency heuristic).
- **`/deep-research` for the open-web recon *prelude* only** (OSINT/CVE/scope background — it fans out + votes per-claim + cites). Keep EKLAVYA active-surface discovery + JS-bundle AST + auth-detect custom — those hit the live target and are the real moat.
- **Get on the prompt-cache-fixed CC version NOW** — free ~3× `cache_creation` cut on sub-agent fan-out + `--resume` cache-miss fix. **Direct June-15 cost relief at zero code cost.**
- Fold the verified **16-concurrent / 1,000-total** workflow caps into the cost model (an 11-specialist squad runs flat; "15 targets × N specialists" *queues*).

**Self-decision — bounded autonomy where an oracle can verify, human everywhere else.** The discriminator is *"is there external feedback?"*, not inside-vs-outside a dispatch. Add: **A1** bounded tool-call retry/self-heal (≤2 attempts) on a failed curl/Playwright/active-PoC call — fixes the silent-drop bug class *as a feature*; **A2** oracle-disagreement deep-probe — when oracle and KRIPA disagree, spawn ONE deeper pass instead of dropping to Low (the false-negative counterweight as a bounded decision); **A3** specialist-pruning at recon — autonomously *don't* spawn irrelevant specialists (no SQLi agent on a static JSON endpoint) = the biggest safe June-15 cost lever. **Never** add bare "agent, re-check your own finding" self-correction (ICLR-2024: intrinsic self-correction without an oracle *degrades* quality). Human stays for: **ship / promote-severity / self-modify.**

**Cross-agent live collaboration — SKIP, with one narrow exception.** Live debate's #1 failure is groupthink (65% of debate errors = collective delusion) — *uniquely toxic for a security tool*, the exact false-consensus KRIPA+oracles exist to kill. **Do NOT use Agent Teams** (shared-task-list peers, no session resumption → resurrects the parallel-dispatch race that clobbered 3/5 stocks). The *one* slice where debate's real win (judge-time, adaptive-stop) applies: a **2-3 judge council on CRITICAL-publish verdicts ONLY** — a workflow fan-out+vote (NOT Agent Teams), unanimous-first-pass costs ~1 extra call, dissent → **escalate-to-human, never auto-publish**. Caveat: on one Max plan every judge is the same model class (amplifies shared bias) → this slice is *borderline*, lowest priority, build only after the recall metric lands. 2026 pentest SOTA (0sec/Shannon/autonomous) IS fan-out+oracle-replay — **we're aligned with the frontier, not behind.**

**What we are deliberately NOT building (KISS — resist the FOMO):** Agent Teams / live debate-as-spine · Google A2A (no second party) · LATS/Tree-of-Thoughts/MCTS · learned router-*agent* (rule-based `model-router.js` is correct < 500 calls/day) · Process Reward Models (need banned fine-tuning) · Nous-Psyche weight-training · skill marketplace (supply-chain surface into a tool that reads attacker HTML) · multi-channel ingress · vector DB / Letta (md-files is the validated 2026 choice — OpenClaw at 163K stars converged there) · a full N-jury judge panel (same-model bias at 3× cost on an oracle-gated decision) · write-config UI / hot-reload (dual-writer race class) · naming a "Semantic Firewall" (we already enforce quarantine+data-fence+scope-recheck) · rebuilding an "Agentic OS" from creator content (it's a dashboard over primitives we already run, minus our gates + oracle floor + hostile-target security).

**Config / "Agentic OS" — already strong.** Spine+ports+squads IS a sound, *more honest* agentic-OS kernel (scheduler=WAL+cron; context-mgr=subagent isolation; memory=remember port+Dreaming; tool-mgr=MCP+ports; access=allowlist+quarantine; self-improve=gated loop). One real add: a per-squad **`squad.yaml`** consolidating the operational knobs (severity profile, model/effort tier, eval path, caps, enabled phases) that are currently scattered in JS — **closes the hardcoded-model-string gap**, makes squads diffable, rendered **read-only** in mission-control. Optional: a **credit/token analytics view** in mission-control (genuinely useful only because June-15 makes that data matter).

## Typed-boundary refinements (ADP-paper audit, 2026-06-04)
An adversarial audit against arxiv 2601.19752 ("Agentic Design Patterns: A System-Theoretic Framework" — conceptual taxonomy, zero benchmarks) confirmed **10/12 patterns covered or deliberately rejected** — but its central thesis (*brittleness comes from missing TYPED subsystem boundaries*) exposed the design's biggest remaining structural blind spot, one we have **already paid for twice in production**. Full verdict: `2026-06-04-adp-paper-audit.md`.

1. **Typed inter-phase envelope (ADOPT — high confidence, highest leverage).** The ports are named by *verb* (run-agent, check-result, remember…) but none specifies an I/O **type**; every phase seam is glued by file-path convention + regex. This already bit us, exactly as the paper predicts: the KRIPA→judge seam regex (`VERDICT_RE`) broke twice (2026-05-11/15), **silently starving Phase 3.075+3.9 on a live Lenovo run**; `finding-schema.js` documents 22 distinct key signatures across 48 production findings; GATE-59/62 are after-the-fact point-patches each locking ONE file path. Adopt: a **versioned envelope schema validated at every phase seam** (recon→specialist, specialist→KRIPA, KRIPA→judge, judge→VYASA, constructor→chain-verifier), policy **fail-into-quarantine-LOUD** (composes with GATE-FAILSOFT-OBSERVABLE; fail-soft pipeline preserved — the record is quarantined visibly, never silently coerced or lost), plus **GATE-INTERPHASE-CONTRACT** forbidding any phase from reading raw producer output outside the envelope. Generalizes the existing `validateFinding` chokepoint from one coercion layer at one boundary to a real contract at all of them. This is the root-cause fix for the whole silent-drop/stale-file/field-name-mismatch incident class.
2. **Typed Feedback record for OBSERVE (ADOPT — medium).** The learning loop's OBSERVE stage must consume a **typed episode record emitted at phase completion**, not grovel over JSONL logs — `trajectory-observer.js` already documents log pollution by specialist shell-echo writes forcing schema_version filter workarounds. If the feedback the loop learns from is polluted, it learns the pollution. Largely formalizes data the spine already writes; same root as "the 40 eval dirs are rubrics, not recall fixtures."
3. **A4 — bounded re-prioritization wave (ADOPT — medium).** Today the spawn set is frozen at recon: A3 only ever *subtracts*, and `/goal` deepens ONE objective. When a **confirmed finding / oracle hit reveals a new in-scope surface** (an unexpected admin API, an SSRF opening internal surface), nothing re-allocates remaining budget toward it — and for a security tool the highest-value finding is often the one recon didn't predict. Adopt **one** bounded re-spawn wave (≤1 per dispatch), triggered ONLY by external oracle-verified signals — passes the design's own "is there external feedback?" discriminator; never bare LLM "maybe I should pivot."
4. **Unified PreToolUse action-gate (cheap unification — borderline).** Not a new pattern: generalize the three existing in-flight controls (quarantine, GATE-EGRESS-DENY, active-PoC engagement gating) into **one native PreToolUse hook** evaluating privileged actions against a small per-squad conduct rubric in `squad-policy` (destructive-PoC shapes, exfil-shaped egress), deny → escalate-to-human. Closes the gap that every live control today is either a single scope predicate or down-weight-only — none can block a harmful-but-in-scope ACTION mid-flight. DHARMA grades *after* the act; this is the only control with teeth *during* it.

*What the audit confirmed we already do better than the paper:* Recorder (WAL+resume, deliberately stateless reasoning), Deliberator (LATS/ToT correctly rejected), Coordinator (groupthink rejection), Executor (SDK structured stream), Strategy/Knowledge split (our 4 improvement types subsume it). The paper earned its read on exactly one axis — typed boundaries — and that axis was our weakest.

## Bottom line
The same 5 ideas you can hold in your head, now **validated as 2026-correct** (the safety rules Anthropic also shipped as Outcomes/Guardrails), **modernized** (dynamic workflows + Agent SDK, not `claude -p`), **self-watching** (a read-only feature watcher + a gated improvement loop — a long bet, not this quarter's lever — with adapters written by hand behind the ports), **high-quality** (a 3-layer live verification floor — oracles + independent verifier + evidence-anchored judge — mostly already in production; plus the false-negative counterweight below), **secure** (hostile-target defenses at every port), and **billing-aware** (measure → interactive/Routines → caps). It auto-improves where it's *safe* to (the 3 known-safe moves), and asks you where it *matters* — and per the independent review, the headline claims are deliberately stated at their **honest** level here, not one notch higher.
