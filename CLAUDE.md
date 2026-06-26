# /root/agents — Kurukshetra Framework

Multi-agent durable orchestrator for security/research workflows. **Read this BEFORE modifying `event-bus.js` or anything under `agents/`.**

> **📊 Current progress + what's next:** `/root/agents/PROGRESS.md` — living doc with done/next/health-check. Read it at session start; update it when a major item completes.

> **🗂️ Folder layout (restructured 2026-06-08):** Personas now live at `squads/<sq>/agents/<name>/` (universals at `_universal/agents/<name>/`), runtime state is evicted to `var/state/agents/<name>/`. **NEVER hardcode a persona path** — use `paths.js` (`agentPaths.soulPath(name)`, `skillsDir`, `personaState`, `lessonsPath`…), enforced by GATE-121. Layout is driven by `layout.config.json` (personaMode/stateMode) + `ownership.json`, read at runtime by both daemon and dashboard (`mission-control/lib/agent-paths.ts` mirrors paths.js). Full map: `STRUCTURE.md`. Design: `docs/research/2026-06-07-kurukshetra-restructure-design.md`.

## What this is

Kurukshetra is a Node.js framework that runs LLM-powered specialist agents across 7 domain squads:

| Squad | Leader | Specialists | Domain |
|---|---|---|---|
| stocks | CHANAKYA | BHISHMA, DRONA, LAKSHMI, NARAD, SURYA, VAYU, SHAKUNI, VIDURA, VISHNU | Equity research |
| pentest | KRISHNA | ARJUN, RUDRA, BHEEM, KARNA, NAKUL, SAHDEV, DRAUPADI, ABHIMANYU, EKLAVYA, SATYAKI, ASHWATTHAMA, YUYUTSU, SHIKHANDI, KRITAVARMA, DHARMA | Web security |
| cloud-security | VARUNA | AGNI, MITRA, SOMA, KUBERA | AWS/Azure/GCP audit |
| network-pentest | SHALYA | INDRA, GHATOTKACHA | Network/AD |
| code-review | VIBHISHANA | DHRISHTADYUMNA, VIKARNA, VIRATA, JAYADRATHA, BARBARIKA, DRUPADA, +UTTARA runtime | White-box review |
| red-team | PARASHURAMA | (varies) | Adversarial |
| ai-security | (lead TBD) | MAYA (scaffolded) | LLM/prompt injection |

Plus universal agents (live in `_universal/agents/`): **SANJAY** (event router, no dir), **KRIPA** (independent verifier), **DHARMARAJ** (confidence-calibrated judge), **VYASA** (final reporter), **ROF** (main-squad lead). Note: **DHARMA** is a pentest specialist per code (`squadId=pentest-squad`), not universal — listed under pentest above.

## Top-level files

| File | Role |
|---|---|
| `event-bus.js` | Main orchestrator (~10K lines). PM2-supervised daemon. **Be careful editing.** |
| `paths.js` | **THE persona/squad path resolver (GATE-121).** `personaCode`/`personaState`/`soulPath`/`skillsDir`/`lessonsPath`/`memoryDir`/`sessionsDir`/`a2aCapsDir`. Reads `layout.config.json` + `ownership.json` at runtime (mtime-cached, fail-soft). Never hardcode a persona path. |
| `layout.config.json` / `ownership.json` | Runtime layout cutover knobs: personaMode (legacy\|nested), stateMode (inline\|evicted) + persona→squad-home map. Flip + `pm2 reload` = move the layout, no code change. |
| `verify-framework.js` | **144/144 regression gates** (all green as of 2026-06-09). GATE-140 canonical-selection (declared sidecar/marker + canonical-author-by-role beat an analyst file with the taskId in its filename — the ITC NARAD>CHANAKYA bug); GATE-141 canonical-race-preserved (same-author dossiers disambiguate by taskId); GATE-142 cost-outlier per-agent baseline + dedup; GATE-143 canonical-selection hardening (author-bound marker/sidecar + prefix canon-match + cross-task sidecar guard + size-aware tiebreak — closes the impersonation class); GATE-121 paths.js resolver chokepoint; GATE-122 persona-homes-intact (restructure); GATE-123 adapter-label truth; GATE-124 suppression counterweight + manual-review reader; GATE-125 phase-envelope wired at KRIPA seam; GATE-126 auto-apply safety perimeter; GATE-127 suppression-recall measured; GATE-128 resolver parity; GATE-129 episode-emission-live (learning loop data source was dead); GATE-130 squad-config consumed; GATE-131 src-tree-layout (modules organized under src/); GATE-132 activity-stall watchdog (hung-but-streaming agent killed on activity-log stall, not just 45min hard cap); GATE-133 ungraded-not-zero (no-eval run → null, never grade-0; baseline+learning loop exclude it); GATE-134 stocks-wave-parallelism (analysts in waves of ≤3, RAM-safe); GATE-135 recovery-loop-cap (never re-dispatch a task whose report exists; cap 2 — the ITC ~$100 burn); GATE-136 learning-loop-triggered (OBSERVE→DISTILL→PROPOSE fires post-dispatch, PROPOSE-only/human-tap, skips ungraded/grade≤0); GATE-137 memory-from-success (high-grade runs bank what WORKED, reflexion/Mem0 pattern); GATE-138 peer-findings-refinement (later analyst sees earlier confidence-ranked findings); GATE-139 high-stakes-proposals-gated (config/routing self-improvements require human tap, never auto-applied; cost-outlier excludes hung/failed runs). GATE-93 families.powerful↔PRICING-row; GATE-94/97 AgentRunner seam; GATE-98 typed inter-phase envelope; GATE-99 suppression ledger; GATE-100 quality tracker; GATE-101 squad configs; GATE-102 changelog watcher; GATE-103 episode-record + learning-loop; GATE-104 goal-evaluator + learning-loop CLI; GATE-105 goal-evaluator wired as default early-exit path; GATE-106 auto-applier (full-auto learning loop); GATE-107 extended thinking at effort=max; GATE-108 episode grade signals; GATE-109 grader sliding window; GATE-110 soul_md_append lessons; GATE-111 reflexion (batch-1 critique → batch 2+); GATE-112 adaptive 2-wave batching; GATE-113 prompt caching; GATE-114 architecture-review bug fixes; GATE-115 final-sprint systems (per-agent override, Phase 2.5 fast-verify, zero-finding alert, dashboard sync, grade-KRIPA correlation); GATE-116 quality sprint (DHARMARAJ evidence fix, challenger, contradiction detector); GATE-117 3-judge consensus on High/Critical; GATE-118 agent SOUL quality; GATE-119 failure-content-aware distill; GATE-120 chain-evidence bridge. Run: `node verify-framework.js` (takes ~2min — uses bun for async test files). |
| `agents/runner/` | **AgentRunner port (LIVE, pure-SDK default).** `agent-runner.js` = chokepoint `runAgent(spec)` → `{text,usage,model,raw}`; default adapter=`sdk`; rollback via `ADAPTER=cli`. `adapters/common.js` = THE env allowlist (v2.1-A1). `meter-probe.js` = billing measurement. `shadow-runner.js` = shadow diff (OFF by default). `run-agent-bridge.js` = legacy shape translator for event-bus call sites. |
| `agents/agents/phase-envelope.js` | Typed inter-phase contract. `wrap(type,payload,{source,taskId})` + `validate()` + `quarantine()` (fail-into-quarantine-LOUD). Root-cause fix for silent-drop/stale-file class. |
| `agents/agents/suppression-ledger.js` | False-negative visibility. Every High/Critical downweight → logged to `/root/intel/suppression-ledger.jsonl`. `logManualReviewNeeded()` for high-conviction/low-evidence findings. |
| `agents/agents/quality-tracker.js` | Per-squad quality baseline. `recordRunQuality()` per specialist run → `/root/intel/quality.jsonl`. `snapshotAllSquads()` → `/root/intel/quality-snapshot.json`. |
| `agents/squads/*/squad.json` | Per-squad operational config (5 files). Declares modelTier, effort, severityProfile, caps, evalPath. |
| `agents/changelog-watcher.js` | Break-detection + CC changelog digest. `node agents/changelog-watcher.js breaks-only` → checks sdk-version-pinned, agent-runner-sdk-default, claude-binary-present, gate-suite-health. |
| `agents/agents/episode-record.js` | Typed episode emitter. `emitEpisode()` per specialist settle → `/root/intel/episodes/episodes.jsonl`. The "Feedback record" the learning loop consumes. |
| `agents/agents/learning-loop.js` | OBSERVE→DISTILL→PROPOSE pipeline. Proposals recorded with `requiresHumanTap:true` (GATE-103). Detects: recurring failures, cost outliers, low-grade clusters. GATE-119: failure-content-aware distill (classifies failure cause → targeted lessons). |
| `agents/agents/auto-applier.js` | **Full-auto-CAPABLE applier (GATE-106) — but DORMANT in production (verified 2026-06-09).** Module is built + tested (kill-switch `LEARNING_AUTO=off`, git-commit per apply, burst-cap 5/24h, quality-watchdog auto-revert), BUT all 3 production `runLoop()` call sites pass `autoApply:false`, so `applyPendingProposals()` is never reached — `applied-proposals.jsonl` does not exist and 0 proposals have ever auto-applied. The live loop is **PROPOSE-ONLY** (OBSERVE→DISTILL→PROPOSE → human review). Deliberately gated off until the grade signal is trusted (episodes currently carry gradeScore=0, so the quality-watchdog has nothing to revert against). Flip `autoApply:true` at the 3 call sites to activate. |
| `agents/agents/goal-evaluator.js` | Oracle-anchored convergence (GATE-104). **Wired as DEFAULT early-exit path** (GATE-105, 2026-06-05): heuristic EARLY_EXIT → one low-effort oracle call → CONTINUE override or confirmed exit. Fail-soft; REACHCHECK alt-scheme path untouched. |
| `squad-framework.js` | SQUAD_TYPES registry — adding a squad = new entry here |
| `model-config.js` | Family→Claude model mapping (fast/balanced/powerful) |
| `model-router.js` | Per-agent model selection logic (avoid hardcoded model strings) |
| `cloud-dispatcher.js`, `network-dispatcher.js`, `pentest-batch-dispatcher.js`, `code-review-dispatcher.js` | Per-squad dispatch entry points called from event-bus |
| `notifier.js`, `telegram-relay.js` | Notification path → `/root/intel/telegram-outbox/` |
| `chain-verifier.js` | Phase 3.6 semantic chain validation (curl + status-code). GATE-120 (2026-06-06): curl results annotate VALIDATED-FINDINGS (`chain_verified`/`chain_evidence`) so DHARMARAJ Stage C judges on real HTTP evidence |
| `agents/*.js` | Per-concern helpers (recently expanded heavily — see Phase 3.075/0.0 wires) |

## Phase Pipeline (universal across squads)

Each dispatch flows through these phases in order. Some are conditional (e.g., pentest-only). All phases are FAIL-SOFT — error in one phase logs and continues.

| Phase | Purpose | Where wired | Squads |
|---|---|---|---|
| **0.0** | **Scope pre-validator** — block OOS targets before any work | `dispatchToAgent` (event-bus.js:8133) | **All 5 squads** (universal) |
| 0.1 | Auth type detection | dispatchPentestParallel | pentest |
| 0.5 | EKLAVYA surface discovery / WAF detect | dispatchPentestParallel | pentest |
| 0.7 | Complexity scoring (model routing input) | dispatchPentestParallel | pentest |
| 1 | Recon (ARJUN, RUDRA — or analysts for stocks) | per-squad dispatcher | varies |
| 1.5 | Spot-check (Haiku misses pickup) | dispatchPentestParallel | pentest |
| 1.6 | JS bundle AST scan for endpoints | dispatchPentestParallel | pentest |
| 1.8 | EndpointModel assumption extraction | dispatchPentestParallel | pentest |
| 2 | Specialist parallel execution (BHEEM/NAKUL/KARNA/SAHDEV/...) — adaptive 2-wave batching (GATE-112) | per-squad dispatcher | varies |
| 2.5 | Fast-verify spot-check (GATE-115) | dispatchPentestParallel | pentest |
| 2.9 | Contradiction detector (GATE-116) | dispatchPentestParallel | pentest |
| 3 | KRIPA independent verifier | per-squad | pentest, cloud, network, code-review |
| 3.05 | KRIPA verdict bridge → VALIDATED-FINDINGS.jsonl | per-squad | same as 3 |
| 3.055 | Challenger agent — adversarial second look (GATE-116) | same | same |
| 3.06 | Scope post-validator (annotates each finding) | same | same |
| 3.062 | prod-endpoint-validator (sandbox vs prod check) | same | same |
| 3.07 | poc-evidence-capture (response body snapshots) | same | same |
| **3.075** | **Severity profile filter — bounty/pentest/comprehensive** | dispatchPentestParallel | **4 of 5** (NOT stocks — stocks uses dispatchStocksParallel) |
| 3.08 | active-poc safe exploitation (env+permission gated) | same | same |
| 3.45 | A2A handoff JSON generation | same | same |
| 3.5 | Inline chain construction | same | same |
| 3.6 | chain-verifier (curl + semantic match) | same | same |
| 3.8 | browser-verifier (Playwright AST) | same | same |
| 3.9 | DHARMARAJ judge w/ promotion gate — 3-judge majority vote on High/Critical (GATE-117), chain-evidence in Stage C (GATE-120) | same | all |
| 4 | VYASA final report (cleanReportForPublish) | same | all |
| 5 | Grading + report blocking (DHARMA) | same | all |

**Phase 0.0 vs 3.075 squad coverage:** Phase 0.0 fires in `dispatchToAgent` (universal entry point — all 5 squads). Phase 3.075 currently fires only in `dispatchPentestParallel` (parallel-phases dispatchType — 4 of 5 squads). Stocks dispatches via `dispatchStocksParallel`, doesn't reach Phase 3.075. Latent design smell flagged 2026-05-15.

## GATE families (verify-framework.js)

Run all: `node verify-framework.js` (~60s, ends with `RESULT: N/N gates passed`).

Conceptual groupings (gates are numbered sequentially, not by family — this taxonomy is informational):

| Family | Example gates | Concern |
|---|---|---|
| **Schema gates** | 1, 2, 4, 13, 14, 15 | Config files, model registry, squad framework integrity |
| **Phase-wire gates** | 65, 71, 72, 73, 74, 77, **80**, **81**, **82** | Phase X.Y hooks present in event-bus.js |
| **Cost / Routing gates** | 5, 7, 25, 36, 37 | Hardcoded model strings, PM2 health, NODE_ENV |
| **Discipline gates** | 11, 12, 17 (evidence/threat-model/disclaimer) | Per-squad caps + provider configs |
| **Security gates** | 8, 9, 24, 25, 26, 30 | Shell-injection, scope literals, auth files |
| **A2A gates** | 65, 66, 68, 70 | Handoff resolver + caps + canonical JSON |
| **Active-PoC gates** | 76, 77, 78 | Engagement mode + permission + library |
| **Chain-verifier gates** | 75, 79 | Multi-binary + semantic match |
| **Promotion/Judge gates** | 67, 69 | DHARMARAJ + extractTargetUrl priority |

When adding a new gate: append after the latest numbered gate in `verify-framework.js`. Pattern:
```js
gate('GATE-N: <one-line invariant>', () => {
  // throw new Error('reason') if check fails; return 'short summary' if pass
})
```

## Critical patterns

### Atomic JSONL writes

Use `writeAtomic(file, data)` (event-bus.js:158) for heavily-contended files like `tasks.json`, `dispatch-queue.json`, `ACTIVITY-LOG.jsonl`. NEVER write directly with `fs.writeFileSync` without a lock.

### File locks

`acquireLock(file, maxWaitMs)` (event-bus.js:172). Stale lock stealing after 10s. Pair with `withFileLock`.

### logActivity helper

```js
logActivity('SANJAY', `🛡️ Phase 0.0: ...`, {
  type: 'scope-prevalidate', squad, taskId, projectId: projectId || '',
  details: `...`,
})
```
- agent UPPERCASE (used by clean-up grep)
- emoji in action OK
- type for downstream filtering
- always include squad/taskId/projectId

### Squad policy adapter contract

`/root/agents/agents/squad-policy/{squad}.js` exports:
```js
{
  squad: 'pentest',       // matches filename, NO -squad suffix
  extractTarget(dispatch),  // returns target identifier for scope check
  matchesScope(target, scopeConfig), // boolean
  cvssOf(finding),         // returns numeric pseudo-CVSS
}
```

Used by both `scope-prevalidator.js` (Phase 0.0) and `severity-profile.js` (Phase 3.075).

### saveAgentReport — dossier selection (race-fix learned hard)

Use `selectBestDossierFile(scanDirs, taskId, leader, cutoffMs, { canonicalSpec })` from `agents/dossier-selector.js`. The published report must be the **canonical author's** file — resolved by ROLE via `canonicalReportRole(squad)`: analysis squads (stocks) → the leader (CHANAKYA); security squads → the reporter (VYASA), **NOT** their leader (KRISHNA/VARUNA/… write side artifacts). Priority (highest first):
1. **P0a Sidecar** — `/root/intel/reports/<taskId>.canonical` JSON pointer (unspoofable by filename; makes re-grades idempotent)
2. **P0b Marker** — `<!-- KURUKSHETRA-CANONICAL taskId=<taskId> … -->` on line 1 of the file
3. **F1** canonical-author file + taskId in filename (race-safe across simultaneous tasks)
4. **F2** canonical-author file + taskId in content header (matches `Task ID`/`taskId`/**`Internal Ref`**)
5. **F3** canonical-author file, newest in window
6. **F4** ANY filename contains taskId (DEMOTED — analyst files land here, below the canonical author)
7. **F5** ANY filename contains the raw `leader` param · **F6** ANY content has taskId · **F7** newest

`saveAgentReport` stamps the P0 marker + sidecar atomically with the report write, so correctness never depends on the agent naming its file correctly. Legacy 4-arg callers (no `canonicalSpec`) collapse to the old taskId>leader>content>newest order (+ marker support + widened regex) — backward-compatible. Locked by **GATE-140/141** (+ GATE-82/85). Never re-implement inline.

History: 2026-05-15 race-fix (3 of 5 stocks clobbered, taskId-preference); 2026-05-16 leader-over-content (Chennai); **2026-06-09 canonical-by-role + declared marker/sidecar (ITC: NARAD analyst file out-ranked CHANAKYA synthesis via filename-taskId)**.

### NEVER hardcode model strings

Use `modelRouter.resolve(agentName)` not `model: 'claude-sonnet-4-6'`. Hardcoded strings bypass family-tier routing.

## Working directory rules

- Work from `/root/agents` (NOT a worktree). Direct-to-master is approved.
- Tests: `bun test test/<file>.test.js`
- Pre-existing `test/browser-verifier.test.js` has a playwright timeout — skip
- Runtime memory drift in `*/memory/grades.json` is normal — DO NOT commit these
- Stage specific files only (never `git add -A`)
- Co-Authored-By footer: `Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Active subsystems (in production)

| System | Status | Notes |
|---|---|---|
| Phase 0.0 scope-prevalidator | LIVE (2026-05-15) | Fail-open on missing config |
| Phase 3.075 severity-filter | LIVE | DOWNGRADE-NOT-DROP via ARCHIVED-FINDINGS-{taskId}.jsonl |
| Phase 3.07 evidence-capture | LIVE | poc-evidence/ dir |
| Phase 3.45 rule-based handoff | LIVE | Universal markers + post-processor |
| Phase 3.6 chain-verifier semantic | LIVE | curl + status-code-range |
| Phase 3.9 DHARMARAJ + promotion | LIVE | Medium→High promotion via 4-stage rubric |
| dossier-selector race-fix | LIVE (2026-05-15) | taskId-preferred 4-tier |
| Telegram outbox relay | LIVE | PM2-managed |
| Supervisor heartbeat | LIVE | 27d uptime |

## See also

- `/root/intel/CLAUDE.md` — data layer schemas (dispatch-queue, tasks, projects, scope configs)
- `/root/CLAUDE.md` — communication style + plan-first workflow
- `/root/.claude/projects/-root/memory/MEMORY.md` — cross-session learnings
- `/root/agents/docs/superpowers/plans/` — historical implementation plans
- `/root/agents/docs/research/2026-06-03-kurukshetra-START-HERE.md` — **next-gen architecture** (design): inside-CC, dynamic-workflows + Agent SDK, domain-agnostic kernel, gated self-improvement loop. Canonical: `…-THE-FRAMEWORK.md`.
- `/root/mission-control/DESIGN.md` — UI design system
