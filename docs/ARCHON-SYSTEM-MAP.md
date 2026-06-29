ARCHON — Top-to-Bottom System Map

> Audience: a senior engineer onboarding before an improvement push. This is synthesized from 17 subsystem maps + 2 end-to-end flow traces. Where the maps disagree with the docs (or with each other), this document follows the **code** and flags the divergence. Items marked *(uncertain)* were inferred from source reading but not executed live.

---

## 1. What ARCHON is & who uses it

ARCHON is a **durable, multi-agent autonomous web-application penetration tester**: a long-lived Node.js daemon (codename **NEXUS**, `event-bus.js`) that orchestrates LLM "specialist" agents against a target, validates their claims into evidence-backed findings, and produces one operator-triaged report. It is **single-operator, localhost-first** — one human authorizes an engagement, dispatches it through a local dashboard, watches the pipeline, triages findings, then generates the report.

**The defining auth model:** ARCHON runs on the operator's **Claude subscription via OAuth — there is no `ANTHROPIC_API_KEY`**. Every model call ultimately shells out to the bundled `claude` CLI (`KURU_CLAUDE_BIN`), which authenticates from `~/.claude`. This is the #1 onboarding gotcha and is load-bearing throughout (the agent-runner, grader, and quota logic all assume the no-key path).

**Three engagement modes:**

| Mode | Engine | What it does |
|---|---|---|
| **Black-box** | `dispatchPentestParallel` (in `event-bus.js`) | Live-URL pentest: recon → stack fingerprint → parallel specialist waves firing payloads → AUDITOR validation → judge → SCRIBE report. |
| **Static / white-box** | `src/dispatch/code-review-dispatcher.js` | Source-only review: scripted inventories → App Blueprint → feature-by-feature mapping → per-class vuln assessment → AUDITOR → SCRIBE. No payloads fired. |
| **White-box merged** | both engines + `src/pipeline/cross-view-dedup.js` | A combined engagement runs a black-box iteration AND an independent code-review iteration, then deterministically de-duplicates the two views into one report (operator-gated). |

**Two squads** drive these:

| Squad | Leader | Specialists | Domain |
|---|---|---|---|
| pentest | ATLAS | SCOUT, RANGER, TRACER (recon) · VIPER, DRILL, RELAY, VAULT, WARDEN, GATEWAY, SENTRY, KEYRING, LEDGER, FORGE, DECOY, SPECTRE | Black-box |
| code-review | CURATOR | MARSHAL, CIPHER, QUILL, BEACON, BREAKER, SIPHON · PROBER (runtime validator) | White-box |

Universal agents (`_universal/agents/`): **AUDITOR** (independent verifier), **ARBITER** (confidence judge / publication gate), **SCRIBE** (reporter), **COMMAND** (coordination).

**Safety stance (non-negotiable, two layers):**
- **Scope is fail-closed.** Phase 0.0 (`agents/scope-prevalidator.js`) blocks any dispatch with no scope config unless `ARCHON_SCOPE_OVERRIDE=1`.
- **Impact-proving exploits fire only behind a 3-gate perimeter** (`engagement_mode:active-poc` + a permission token + `ARCHON_ACTIVE_POC`). Default fires nothing — detecting vulns is the specialists' normal remit; *demonstrating* RCE is gated.
- **Triage-gated reporting** is the product differentiator: the pipeline runs to `AWAITING-TRIAGE` and stops; the operator confirms/rejects/sets CVSS, then explicitly triggers SCRIBE. No report is auto-published.

> ⚠️ **As shipped, the entire offensive (active-poc/exploit-prover) perimeter is unreachable** — see §8 Tier 0. The safety *posture* is sound; the firing path is dead code today.

---

## 2. Architecture at a glance

```
                         OPERATOR (browser)
                              │  HTTP (127.0.0.1:4000)
                              ▼
        ┌─────────────────────────────────────────────────┐
        │  DASHBOARD  scripts/dashboard.js + ui/ (vanilla SPA)│
        │  reads var/intel (tasks, findings, reports, health)│
        │  NEVER writes core state directly                  │
        └───────────────┬─────────────────────────────────┘
                        │ atomic tmp+rename
                        ▼
            var/intel/inbox/task-actions/*.json   var/intel/cancel-signals/*.json
                        │ (fs.watch 500ms + 10s poll)
                        ▼
   ╔════════════════════════════════════════════════════════════════════╗
   ║  DAEMON  event-bus.js  (NEXUS, ~10.8K lines, single process, PM2)    ║
   ║                                                                      ║
   ║  inbox watcher ─► dispatch-queue.json (pending)                      ║
   ║         │ fs.watch + 30s heartbeat                                   ║
   ║         ▼                                                            ║
   ║  processQueue ─► dispatchToAgent(dispatch)                           ║
   ║         │   caps: 3/leader, 6 global                                 ║
   ║         ▼                                                            ║
   ║  Phase 0.0 SCOPE GATE (fail-closed) ──► getSquadDispatchType         ║
   ║         │                                  │                          ║
   ║   parallel-phases                     code-review                     ║
   ║         ▼                                  ▼                          ║
   ║  dispatchPentestParallel       code-review-dispatcher.runCodeReview   ║
   ║   (phases 0.4→4, fail-soft)     (inventories→blueprint→...→SCRIBE)    ║
   ║         │                                                            ║
   ║         ▼  per phase                                                 ║
   ║  spawnAgent(ctx) ──► bridgeSpawnAgent ──► runAgent(spec)             ║
   ║         (agents/runner/agent-runner.js  = the LLM chokepoint)        ║
   ║                          │                                           ║
   ║                  adapter: sdk (default) | cli (rollback)             ║
   ║                          ▼                                           ║
   ║              @anthropic-ai/claude-agent-sdk ─► `claude` CLI subprocess║
   ║                          ▼                                           ║
   ║                  CLAUDE (OAuth via ~/.claude — NO API KEY)           ║
   ╚════════════════════════════════════════════════════════════════════╝
                        │  agents self-append findings (shell/echo)
                        ▼
   live-findings-<id>.jsonl ─AUDITOR─► ACTIVITY-LOG (CONFIRMED/KILLED)
                        │ auditor-validated-builder (evidence contract)
                        ▼
   VALIDATED-FINDINGS-<id>.jsonl ─judge(3.9)─► JUDGED-FINDINGS-<id>.jsonl
                        │
                        ▼
   SCRIBE ─► pentest/FINAL-REPORT.md ──(extractAndSavePentestReport)──► reports/<taskId>.md
                                                  │
                                          ARBITER verification loop (publication gate)

   ── DATA LAYER ──  var/intel  (= KURU_INTEL_ROOT; gitignored)
      tasks.json · dispatch-queue.json · ACTIVITY-LOG.jsonl · health.json · quota.json
      scope/env-fingerprint/attack-plan/correlation-<id>.json · reports/ · code-review/
      orchestrator/{checkpoint.json,events.jsonl} · handoffs/{inbox,done,failed}

   ── PERSONA / SQUAD LAYOUT ──  (resolved ONLY through paths.js)
      squads/<sq>/agents/<name>/SOUL.md + skills/      (persona content)
      _universal/agents/<name>/                         (AUDITOR/ARBITER/SCRIBE/COMMAND)
      agents/squads/<sq>/squad.json                     (operational knobs — DIFFERENT tree!)
      var/state/agents/<name>/memory/                   (runtime state, "evicted" mode)
      ownership.json + layout.config.json               (persona→home map + layout modes)
```

---

## 3. The daemon core (`event-bus.js`)

`event-bus.js` is the event loop and durable state machine. It exports **nothing** and imports the whole system; it is only ever executed (guarded by `if (require.main === module)`), never required.

**Lifecycle (`startWatcher`, 10271):** preflight the `claude` CLI → `replayAndRecover()` (replay `checkpoint.json` + `events.jsonl`) → first `processQueue()` → install `fs.watch` on `dispatch-queue.json` + ~11 `setInterval` timers (queue 30s, stuck-task 5m, heartbeat 45s, supervisor-inbox 30s, task-actions 10s, cancel 2s, orphan-reaper 60s, findings-ingest 15s, **health 10s**, handoff 30s, checkpoint 60s) → arm checkpoint persister → stale-status sweep.

**Work enters through 4 filesystem channels** (the filesystem *is* the IPC boundary — no in-process API):
1. UI/API: dashboard `writeInbox()` → `inbox/task-actions/` → `processTaskActionsInbox` pushes a `pending` entry to `dispatch-queue.json`.
2. Direct queue writes (scripts), caught by `fs.watch`.
3. Calendar (only if `ARCHON_CALENDAR=1`).
4. Recovery: boot replay, the 5m stuck-task watchdog, supervisor "retry" signals.

**Two parallel state machines, reconciled (not designed) into sync:**
- dispatch-queue entries: `pending → processing → completed | failed | cancelled`
- tasks: `backlog/active → in-progress → awaiting-triage → done | failed | cancelled`

Large parts of `_processQueueInner` exist solely to re-sync them (sticky-cancel healing, stale-running reconcile). **There is no central status enum** — bare string literals are compared inconsistently (`!== 'in-progress'` in one place, `['in-progress','active','backlog'].includes(...)` in another).

**Critical concurrency patterns (the load-bearing primitives, `event-bus.js:192-246`):**
- `writeAtomic(file,data)` — tmp-write + rename. Atomic at FS level only; **not** safe against concurrent read-modify-write.
- `acquireLock(file, maxWaitMs=30000)` — advisory cross-process `.lock` sidecar (`O_CREAT|O_EXCL`), steals locks older than 10s, throws on timeout. ⚠️ Backoff uses `Atomics.wait` on the **main thread** — under real contention the whole single-threaded daemon stalls (mitigated only by tiny critical sections).
- `withFileLock(file, fn)` / `updateTasksAtomic(taskId, mutator)` — the canonical lock-protected RMW. `writeJSON` auto-locks only the two `SHARED_JSON_FILES` (`tasks.json`, `dispatch-queue.json`).
- `logActivity(agent, action, extra)` — dual-writes JSONL to the global `ACTIVITY-LOG.jsonl` **and** a per-task log (`src/utils/task-log.js`), with a PIPE_BUF<4096 atomic-append guard.

**Recovery is four overlapping mechanisms** with scattered magic-number thresholds: boot `replayAndRecover`, the in-queue reconcile passes, `runStuckTaskWatchdog` (45min/3-retry, 25min zero-finding alert), and the 10s `src/ops/supervisor.runHealthPass` (auto-heals the zombie-cancel gap, writes `health.json`, escalates to an Opus SENTINEL diagnostic). This is the densest tech debt in the file — each pass is a dated "LOCAL PATCH" tracing to a specific production incident.

**Known core defects (see §8):** the global concurrency cap is evaluated against a stale pre-loop snapshot; `runningAgents` is a single process-global `Set` keyed by agent **name**, causing cross-task interference when two same-squad tasks run the same specialist.

---

## 4. End-to-end lifecycles

### 4a. Black-box pentest (grounded in Trace 1)

**Entry is two hops, not one:** dashboard writes `inbox/task-actions/*.json` → `processTaskActionsInbox` enqueues into `dispatch-queue.json` → `fs.watch` on the *queue* triggers `processQueue` → `dispatchToAgent`.

`dispatchToAgent` (8482) runs **Phase 0.0 scope pre-validate** (universal, *above* the pipeline) — fail-closed; a block marks the queue entry failed and returns. Then routes pentest → `dispatchPentestParallel` (a single ~2,200-line async function, 4368–6580).

**Actual execution order ≠ numeric order** (phase numbers are historical labels):

| Real order | Phase | What | Gate |
|---|---|---|---|
| 1 | 0.4 | nmap `-sV -p-` "heart-truth" service scan | full scan only |
| 2 | 0.45 | canonical-target / vhost resolution (mutates `targetUrl`) | |
| 3 | 0 / 0.1 | WAF detect + auth-type fingerprint | |
| 4 | (0.5) | **TRACER crawl** (crawl4ai/katana/gau) — *only if* endpoints file missing | |
| 5 | 0.7 | complexity scoring (drives model routing) | |
| 6 | 1 | recon = **SCOUT + RANGER only** (TRACER already ran) | `skipRecon` |
| 7 | 1.5 | spot-check (Haiku second opinion) | complexity<4 |
| 8 | 1.6 | JS-bundle endpoint scan (**fire-and-forget, un-awaited**) | |
| 9 | — | early-exit decision (+ goal-evaluator oracle override) | |
| 10 | 1.8 | EndpointModel | **off by default** (`archon_PHASE_1_8`) |
| 11 | 0.6 | env-fingerprint (runs *after* recon, despite "0.6") | |
| 12 | 1.9 | ATLAS strategist (WSTG-walked attack plan, Opus) | |
| 13 | 2 | **Wave 1** specialists (batches 1+2, parallel) | |
| 14 | 2.5 | fast-verify (top wave-1 finding) | |
| 15 | 2 | **Wave 2** (batches 3+4) + reflexion critique | budget gate |
| 16 | 2.9 | contradiction detector (pure, no LLM) | |
| 17 | 3 | **AUDITOR** re-probes → appends CONFIRMED/KILLED to ACTIVITY-LOG | |
| 18 | 3.05 | `auditor-validated-builder` bridges log verdicts → `VALIDATED-FINDINGS` (**evidence contract enforced here**) | |
| 19 | 3.1–3.08 | enrich · challenger · scope annotate · prod-flag · evidence-capture · severity-filter · active-poc | each fail-soft |
| 20 | 3.085 | exploit-prover (nonce proof) | 3-gate |
| 21 | 3.087 | ATLAS re-plan | |
| 22 | 3.4–3.6 | attack-graph · cross-squad handoffs · chain construct + curl verify | |
| 23 | 3.7 / 3.8 | offensive-vaccine remediation · browser verification | |
| 24 | 3.9 | **Judge Verifier** (3-judge consensus, Haiku) — writes `JUDGED-FINDINGS` | `archon_PHASE_3_9` |
| — | — | **triage gate**: if set, stop at `awaiting-triage`, defer SCRIBE | |
| 25 | 4 | chain-orphan pre-guard → **SCRIBE** writes `pentest/FINAL-REPORT.md` | |
| 26 | post | grade → `extractAndSavePentestReport` → `reports/<taskId>.md` → **ARBITER verification loop** (the real publication gate) | |

**Three doc/code divergences that matter:** (1) TRACER is not a Phase-1 recon agent; (2) Phase 3.9 is the deterministic *Judge Verifier* (`scripts/run-judge-verifier.js`), **not** the ARBITER persona — ARBITER runs *later*, post-grading; (3) findings are written **by the agents themselves** via shell/echo into `live-findings`/`ACTIVITY-LOG`, not parsed from agent stdout by the daemon.

**Two report files:** SCRIBE's canonical author file is `pentest/FINAL-REPORT.md` (fixed name, overwritten each run); the *published* report is `reports/<taskId>.md`, produced by `extractAndSavePentestReport` during post-dispatch grading.

### 4b. White-box code-review (grounded in Trace 2)

Dispatched as `squad:'code-review'` (or via the pentest form's Static/White-box buttons). `runCodeReview(dispatch, deps)` is self-contained, all prompts inline:

1. **Phase 0** `validateSourceDir` — absolute path, ≥1 code file (depth≤3, cap 100).
2. **0a** `buildInventories` — scripted `grep -rEn` enumeration (head-capped at 8000 lines), per-preset (gitlab marker sniff vs generic).
3. **0b** CURATOR writes `app-blueprint.md` (1-page architecture, authN/authZ files, trust boundaries).
4. **0c** feature queue: explicit `meta.features` > gitlab preset (`gitlab-features.json`, 43 features) > generic CURATOR discovery.
5. **1** per-feature mapping — one specialist per feature in **waves of 3**, round-robin over the 6-agent MAPPER_POOL; each writes a 13-section feature map with an Endpoint/Action Ledger.
6. **1c** CURATOR consolidation → matrices + **ranked** `phase2_review_queue.md` + completion gate.
7. **2** per-class assessment — `vulnClasses × features.slice(0, maxPhase2=6)` routed to the class specialist (access-control→MARSHAL, xss→CIPHER, etc.).
8. **2v** AUDITOR reverse-check (+ PROBER live validation if `deployUrl`) → `AUDITOR-VERDICTS.md`.
9. **3** SCRIBE → `FINAL-REPORT-<taskId>.md`.
10. **bridge** `normalizeCodeReviewFindings` — a *second* AUDITOR LLM pass converts the markdown verdict table → `VALIDATED-FINDINGS-<taskId>.jsonl`.

**Merge path (operator-gated):** a combined engagement records both iterations in `engagement-<id>.json`. On a `generate-report` inbox action, `generateReportForTask` calls `buildCorrelationMap` (`cross-view-dedup.js`) → `correlation-<taskId>.json` (`exact_duplicate_groups` + `cross_view_candidates`, grouped by **vuln-class only**), and SCRIBE emits one de-duplicated report at `reports/<engagementId>.md`.

---

## 5. Subsystem reference

### Orchestration
- **Daemon lifecycle/queue/state** — `event-bus.js` (see §3). Sole writer of `tasks.json`/`dispatch-queue.json`/`ACTIVITY-LOG.jsonl`. Wired to everything via `require`; freshRequire's the two pipelines for live-patchability.
- **Black-box pipeline** — `dispatchPentestParallel` (in `event-bus.js`) + `src/pipeline/pentest-phases.js` (`PHASE_MANIFEST` + `phaseEnabled()` gate reading `agents/squads/pentest/squad.json`). The "pipeline depth = config" contract is **largely fiction** today (most optional phases aren't actually wrapped in `phaseEnabled`).
- **White-box pipeline** — `src/dispatch/code-review-dispatcher.js`; routed via `SQUAD_TYPES['code-review']` in `src/core/squad-framework.js`.
- **Cross-view dedup** — `src/pipeline/cross-view-dedup.js` (pure, tested).

### Agents & personas
- **Agent runner / LLM chokepoint** — `agents/runner/agent-runner.js` `runAgent(spec)→{text,usage,model,raw}`; adapters `adapters/sdk.js` (default, OAuth), `adapters/cli.js` (rollback via `ADAPTER=cli`), `adapters/common.js` (the canonical env allowlist — never spreads `process.env`). `run-agent-bridge.js` re-wraps to the legacy `{code,output,cost,model}` shape the retry path expects. Thorough DI-based tests; SDK/CLI never actually invoked in CI.
- **Personas / squads / path resolution** — `paths.js` is THE resolver chokepoint (portable roots `KURU_AGENTS_ROOT/INTEL_ROOT/CLAUDE_BIN`, `.env.local` autoload, mtime-cached `ownership.json` + `layout.config.json`). `soulPath/skillsDir/memoryDir/lessonsPath` accessors — **never hardcode a persona path** (GATE-121, doc-only enforcement). Squad behavior: `SQUAD_TYPES` registry + `agents/squad-config-loader.js` (reads `squad.json`). ⚠️ Persona *content* lives at top-level `squads/<sq>/agents/`, but operational `squad.json` lives at `agents/squads/<sq>/` — two trees, easy to edit the wrong one. The run-roster is fragmented across ~6 disconnected places.
- **Prompt building** — the `build*Prompt` family in `event-bus.js` (specialist/auditor/scribe/curator/prober/chain), `scrubBaselineFromGoal` (`src/safety/scrub-*`), `src/rendering/prompt-renderer.js` (versioned templates — only `specialist` + `chain-analysis` exist; SCRIBE/AUDITOR remain inline).

### Pipeline (recon/fingerprint/planning/proof)
- **Recon & planning** — `src/pipeline/`: `nmap-scan.js`, `target-resolver.js` (vhost pinning, injection-safe `--resolve`), `env-fingerprint.js`, `attack-planner.js` (WSTG-walked), `attack-graph.js`, `early-exit-decision.js`, `outcome-classifier.js`. Mostly pure + tested; `attack-graph` carries dead stocks code; `target-resolver`/`nmap-scan` have only embedded self-checks, no CI tests.
- **Proof / chains / evidence** — `src/pipeline/evidence-contract.js` ("no replayable evidence → not CONFIRMED"), `exploit-prover.js` (nonce-verified, gated), `chain-verifier.js` (**shell-free** curl replay: argv-only, metachar reject, binary allowlist — solid security model), `evidence-completeness.js` (severity-cap math, **never wired** — duplicated as a prompt), `loose-jsonl.js` (salvage parser). `agents/auditor-validated-builder.js` is the real enforcement point; `agents/poc-evidence-capture.js` writes artifacts **nothing reads**.

### Evidence & findings
- **Schema/judging/severity** — `agents/finding-schema.js` (canonical normalizer — though `tools/emit-finding.js` bypasses it with its own normalizer), `agents/judge-verifier.js` + `scripts/run-judge-verifier.js` (4-stage Raptor judge, consensus/promotion), `agents/severity-profile.js` (CVSS floor bounty/pentest/comprehensive), `agents/suppression-ledger.js` + `agents/review-queue.js` (downgrade visibility — but the manual-review loop is **never closed**), `agents/scribe-chain-orphan-guard.js`, `agents/dossier-selector.js` (`selectBestDossierFile`, 8-tier author-bound heuristic — used for *grading* selection, not report publishing).

### Safety
- **Scope** — `agents/scope-prevalidator.js` (Phase 0.0, fail-closed), `agents/scope-validator.js` (Phase 3.06, annotate-only), `agents/squad-policy/{pentest,code-review}.js`.
- **Active-PoC / exploit** — `agents/active-poc-policy.js` (3-gate + caps + defender-abort), `agents/active-poc-runner.js`, `agents/active-poc-library/`, `src/pipeline/exploit-prover.js`. ⚠️ **Dead in the daemon** (§8 Tier 0).
- **Hygiene** — `src/safety/scrub-baseline.js`, `scrub-goal-paths.js`, `thrash-quarantine.js`, `offensive-vaccine.js` (mis-located report-remediation generator, not a gate).

### Routing & models
- **Model router** — `src/routing/model-router.js` `getModelForAgent(agent,{complexityScore,squad})` + `resolveFamily`. Config in `${INTEL_ROOT}/model-config.json` (seeded by `scripts/setup-local.js`; absent in a fresh checkout → `_hardcodedFallback`). Adjacent: `agents/llm-model-resolver.js` (off-squad CLI), `agents/model-config.js` (MODEL_PROFILE override shim — confusingly named), `agents/tech-affinity.js`, `src/routing/target-classifier.js` (priority-ordering half is **inert**). ⚠️ **CLAUDE.md documents `modelRouter.resolve()` and `src/routing/model-config.js` — neither exists.**

### Learning
- **Feedback loop / memory** — `src/learning/feedback-loop.js` (post-task trace mining → lessons + disproven cache, prompt injection, fresh-eyes anti-anchoring gate), `memory-ranker.js` (relevance ranking), `versioned-memory.js` (**write-only** since a dead-code purge), `agents/trajectory-observer.js` (observe-only), `src/utils/task-log.js` (the O(task) fast path).

### Verification
- **Judge** (§Evidence above) + **browser verification + JS analysis** — `agents/browser-verifier.js` (Playwright executor) + `browser-recipe-validator.js` + `browser-evaluate-ast.js` (acorn read-only guard), `pentest-browser-recipe-constructor.js`, `js-bundle-analyzer.js`(+ `-ast.js`), `endpoint-analyzer.js`. Two `url-extractor.js` modules (`agents/` vs `src/utils/`) with different APIs.

### Observability & ops
- **Dashboard/UI/integrations** — `scripts/dashboard.js` + `ui/{index.html,app.js,cvss.js}` (zero-dep SPA, single-writer discipline via inbox). Integrations (all optional, config-gated, no-op by default): two Langfuse tracers (`src/integrations/langfuse-tracer.js`, `tracer.js`), `notifier.js` (Telegram), `quota-manager.js` (rate-limit state machine), `anthropic-key.js`. Ops: `src/ops/supervisor.js` (pure, well-tested health pass).

### Knowledge base & grading
- **Coverage/taxonomy/common/eval** — `src/core/coverage-map.js` (WSTG; only `checklistText()` used in prod — measured coverage is dead), `common/taxonomy/owasp_wstg.yaml` (hand-kept mirror), `src/grading/grader.js` (regex+LLM hybrid) + `gold-set.js` (kappa harness), `agents/isa-grader.js`, `scripts/g4-*.js` (finished one-off experiment). `common/` is a **file-only KB** (payloads, remediation, taxonomies, stray Python helpers) reached by agents via hardcoded `/root/agents/common/...` path strings in persona docs — which break under portable roots.

---

## 6. Cross-cutting patterns & invariants

| Invariant (from CLAUDE.md) | Where enforced | Status |
|---|---|---|
| **Atomic writes + file locks** on shared JSON | `writeAtomic`/`withFileLock`/`updateTasksAtomic` (`event-bus.js:192-246`) | ⚠️ violated by `quota-manager.js` (bare `writeFileSync`) and `attack-graph.save()` |
| **Evidence contract** — CONFIRMED needs replayable evidence | `evidence-contract.enforceContract` called in `auditor-validated-builder.js` | ⚠️ weak teeth: `proof = details.slice(0,600)`, `MIN_PROOF_LEN=20` → effectively "no details text → demote" |
| **Fail-closed scope** | `scope-prevalidator` at Phase 0.0 | ⚠️ outer try/catch makes it **fail-open on internal error**; no mid-run enforcement |
| **Dossier selection** via `selectBestDossierFile` | `agents/dossier-selector.js` | OK (but note it selects the *grading* dossier, not the published report) |
| **Never hardcode model strings** — use the router | `model-router.getModelForAgent` | ⚠️ violated at `event-bus.js:6414` (`claude-haiku-4-5`), `:10727` (`claude-sonnet-4-6`), `g4-report.js`, stale `opus-4-7` in `llm-model-resolver` |
| **No hardcoded persona paths** (GATE-121) | `paths.js` accessors | ⚠️ doc-only; SOUL.md files embed absolute `/root/intel/...` |
| **Pipeline modules pure + tested** | `src/pipeline/*` + `test/*.test.js` | ⚠️ `target-resolver`/`nmap-scan` untested; the orchestrator wiring them is untested |
| **No `ANTHROPIC_API_KEY`** (OAuth only) | `adapters/common.js` allowlist, `anthropic-key.js` | OK; but `runSeparateGrader` uses raw `fetch`+key → dead in the OAuth deployment |
| **Single-writer** for core state | dashboard writes only inbox files | OK — the load-bearing safety invariant of the UI layer |
| **Fail-soft** pipeline phases | try/catch per phase | OK by design; ⚠️ silent `catch('')` in prompt builders hides regressions |

---

## 7. Data & file layout

**`var/intel/` (= `KURU_INTEL_ROOT`, gitignored, seeded by `npm run setup`):**
- Core state: `tasks.json`, `dispatch-queue.json`, `ACTIVITY-LOG.jsonl`, `task-heartbeats.json`, `health.json`, `quota.json`, `model-config.json`
- Orchestrator: `orchestrator/{checkpoint.json, events.jsonl}`, `agent-status.json`
- Inbox channels: `inbox/{task-actions,processing,processed,dead-letter,supervisor}/`, `cancel-signals/`
- Per-task artifacts: `scope-`, `canonical-target-`, `nmap-`, `pentest-endpoints-`, `env-fingerprint-`, `attack-plan-`, `followup-plan-`, `correlation-`, `engagement-`, `triage-`, `findings-detail-<id>.json`
- Findings spine: `live-findings-`, `VALIDATED-FINDINGS-`, `JUDGED-FINDINGS-`, `ARCHIVED-FINDINGS-`, `proof-of-execution-<id>.jsonl`; `suppression-ledger.jsonl`, `manual-review-queue.jsonl`
- Reports: `reports/<taskId>.md` (published) + `pentest/FINAL-REPORT.md`, `code-review/<taskId>/...`
- Learning: `squad-lessons-<sq>.md`, `disproven-cache-<sq>.json`, `agent-scores.json`, `trajectory/observations.jsonl`, `memory-store/`
- Handoffs: `handoffs/{inbox,done,failed}/*.json`

**Persona/squad tree:**
- `squads/<sq>/agents/<name>/` — `SOUL.md` + `IDENTITY/AGENTS/TOOLS/...` + `skills/<skill>/SKILL.md`
- `_universal/agents/<name>/` — AUDITOR/ARBITER/SCRIBE/COMMAND
- `agents/squads/<sq>/squad.json` — operational config (**separate tree** from content)
- `var/state/agents/<name>/memory/` — runtime lessons/episodes/grades ("evicted" state mode)
- `ownership.json` (28 personas → home) + `layout.config.json` (`personaMode:nested`, `stateMode:evicted`)

**`common/`** — static knowledge base, **not imported by code**, reached by agents via path strings: `taxonomy/` (CWE, OWASP Top-10/API/LLM/Mobile, WSTG), `payloads/` (21 classes, duplicated `.txt`+`.yaml`), `reporting/` (incl. orphaned `finding_schema.json` that has drifted from `agents/finding-schema.js`), `remediation/`, plus **stray Python helpers** (`report_generator.py`, `captcha/*.py`) with zero JS integration.

---

## 8. Improvement surface (aggregated, de-duplicated, prioritized)

> Biggest leverage first. Each item notes **risk/effort** and the contributing map(s). Many maps independently flagged the same root causes — those are merged here.

### Tier 0 — Silent show-stoppers (core function broken, no error surfaced)

1. **`_fastVerifiedContext` `ReferenceError` aborts every full-roster scan after Wave 1.** The wave-2 dispatch at `event-bus.js:5317` references a `let` declared in a *later* sibling block → throws → caught by the outer catch → no Wave 2, no AUDITOR, no judge, **no report**. Focused scans (≤4 specialists) survive. Strongly consistent with the recent commit "surface ALL pentest findings (was showing zero)". **Fix:** hoist the `let` to function scope (one line) and actually run Phase 2.5 before Wave 2. *Risk: low. Effort: trivial.* Confirm this is fully resolved before anything else. [pipeline]
2. **`npm test` is RED.** `test/squad-config-loader.test.js` requires the purged `agents/quality-tracker` (MODULE_NOT_FOUND), and the `PRODUCTION_SQUADS` test expects 5 squads when 2 exist. Fix/delete these first — you cannot trust the gate otherwise. *Risk: low. Effort: trivial.* [personas]
3. **Entire active-PoC / exploit-prover perimeter is dead** — three independent causes: (a) `taskConfig` is never declared in `dispatchPentestParallel`, so the Phase 3.08/3.085 guards always see `undefined`; (b) the env var is checked as lowercase `archon_ACTIVE_POC` while all docs say `ARCHON_ACTIVE_POC` (and tests assert the wrong name → false confidence); (c) `active-poc-runner` passes no `fetchImpl` so every probe would throw. Also `phaseEnabled('3.085')` returns false with the shipped `squad.json`. **Decide:** wire it on (deliberately, with an authorization review) or delete the phases + library. *Risk: high if enabled — it makes a real firing path live. Effort: medium.* [safety, pipeline]
4. **All verified attack chains are silently discarded.** `finding_ids` is dropped between the chain Constructor and SCRIBE (`chain-verifier.verifyChains` + the event-bus projection both omit it), so the Phase-4 orphan guard drops every chain and the ARBITER chain-evidence bridge (which also references a nonexistent `s.http_status`) annotates nothing. The whole chain pipeline (LLM cost + curl replay) produces output that never reaches the report. **Fix:** pass `finding_ids` through in two places; pull status from the injected HTTP marker. *Risk: low. Effort: low.* [evidence]
5. **The handoff (A2A) subsystem fails 100%.** Every producer targets squads that no longer exist (cloud-security/network-pentest/code-review capabilities), but the only `capabilities.json` defines pentest's two — so `resolveTarget` returns null and everything lands in `failed/`. It still burns LLM calls in the 30s watcher and always yields an empty SCRIBE corroboration section. **Fix:** delete/disable for the 2-squad build, or rewrite the 5 rules + prompt to target real capabilities. *Risk: low to delete. Effort: low-medium.* [handoff]
6. **Dashboard-originated white-box runs are scope-blocked at Phase 0.0.** `squad-policy/code-review.extractTarget` reads `dispatch.sourceDir`/`dispatch.target`, but the real path is `dispatch.meta.sourceDir`; nothing hoists it → `validateDispatch` returns BLOCKED (a branch `ARCHON_SCOPE_OVERRIDE` doesn't downgrade for combined runs). *Either operators always set the override, or combined engagements never produce a white-box side.* **Fix:** read `meta.sourceDir`; treat a local source tree as in-scope. *Risk: low. Effort: low — ship with a test through `validateDispatch`.* [white-box]

### Tier 1 — Invariant violations & correctness fragility

7. **Hardcoded model strings** (violates the #1 routing rule, will silently rot): `event-bus.js:6414` (`claude-haiku-4-5`), `:10727` handoff watcher (`claude-sonnet-4-6`, *overrides* the resolved family), `g4-report.js` (`opus-4-7`), and the stale `opus-4-7` fallback in `llm-model-resolver`. Route all through the router; extend `no-hardcoded-model-strings.test.js` to scan the event-bus call sites. *Risk: low. Effort: low.* [findings, handoff, routing, models]
8. **Phase 0.0 fail-closed is actually fail-open on internal error** — the outer try/catch downgrades a missing/broken squad-policy or parse throw to "continue". For a pentest tool this defeats the guarantee exactly when misconfigured. Block (loudly) on scope-relevant errors. *Risk: medium (could block legit dispatches). Effort: low.* [safety]
9. **Concurrency hazards in the daemon core:** the global cap reads a stale pre-loop snapshot (a cross-squad burst can blow past 6 in one pass); `runningAgents` is a single name-keyed global Set → two same-squad tasks running the same specialist cause premature `delete`/idle and checkpoint ghosting (the very "zombie agent" class the reconcile band-aids paper over). Key by `(taskId, agentName)`. *Risk: medium (touches checkpoint shape + UI). Effort: cap fix low, Set fix medium.* [daemon]
10. **`quota.json` written with bare `writeFileSync`** (read-modify-write, no lock) — interleaved updates can lose a cooldown and let the daemon keep dispatching to a rate-limited model. Use `writeAtomic`/`withFileLock`. *Risk: medium. Effort: low.* [observability]
11. **`computeVerdict` auto-CONFIRMs a browser recipe that has no assertion** (`expected_evaluation_results` is optional) — a navigate+screenshot becomes "strong CONFIRM evidence" to SCRIBE. Default to INDETERMINATE; require `verdict_rule` for verdict-bearing types. *Risk: medium (flips some passing recipes). Effort: low-medium.* [verification]
12. **`detectPatterns` reads the 500MB-capable global `ACTIVITY-LOG.jsonl` twice per task** — the exact O(N) main-thread block `task-log.js` was built to eliminate; can make the supervisor think the daemon is dead. Route it through windowed per-task logs. *Risk: medium (cross-task by design). Effort: medium.* [learning]

### Tier 2 — Dead code & removed-squad debt (large, low-risk cleanup)

13. **Stocks / removed-squad debt is pervasive** — de-dup as one sweep: the ~40–99-branch stock-analysis regex ladder in `gradeTask` (₹/P-E/ROE/moat/"15 sections"/narad/surya/...); dead stocks code in `attack-graph.js`; `MUST_GATES_STOCKS` + the `analysis` gateStyle in `squad-framework.js`; the stale `_fallbackAgentIds` roster (~18 removed personas); `stock_*` roles in the model-config seed; `PRODUCTION_SQUADS`. *Risk: low (guarded by keyword checks no live eval hits). Effort: medium.* [prompts/grading, recon, personas, routing, KB]
14. **Dead legacy code-review path** — `event-bus.js:~3981-4226` (`buildSpecialistPrompt` CR usage, `buildproberPrompt`, `buildauditorCodeReviewPrompt`, `buildscribeCodeReviewPrompt`, `buildcuratorChainPrompt`) has zero callers; the `8613-8614` comment ("6 framework specialists") and `SQUAD_TYPES.phases` no longer match the real `PHASES`. ~250 lines of misleading code. *Risk: low (confirm the one test referencing `buildSpecialistPrompt` targets pentest). Effort: low.* [white-box]
15. **Write-only stores / unreachable features** (delete or wire a consumer): `versioned-memory` (write-only post-purge), `poc-evidence-capture` artifacts (never read by SCRIBE), `agent-scores.json` + `squad-patterns-*.md`, `evidence-completeness` module (caps duplicated as a prompt instead), CORS deterministic recipes (`partitionDeterministicRecipes` unwired), `target-classifier` priority ordering, `complexity_scoring` (seeded empty → all routing-upgrade logic dead), `validateModelsAtStartup` (needs API key → always skipped), the manual-review-queue (resolution has no downstream effect). *Risk: low to delete. Effort: low each; "wire" is the higher-value option for poc-evidence + evidence-completeness + manual-review.* [learning, evidence, verification, routing, findings]
16. **Orphans:** `createHandoffFile` (`event-bus.js:416`, no producer/consumer), `common/reporting/finding_schema.json` (drifted, unused), the `common/` Python helpers, the finished `g4-*` experiment scripts (+ 3 test files, stale `opus-4-7`). *Risk: low. Effort: low.* [handoff, KB]

### Tier 3 — Doc/code divergence (actively misleads the improvement push)

17. **CLAUDE.md is wrong in load-bearing ways:** phantom `modelRouter.resolve()` + `src/routing/model-config.js` (already caused patched runtime errors); the phase table omits 0.4/0.45 and mislabels Phase 3.9 as "ARBITER"; the persona roster overstates what the OSS default dispatches. Fix the table, the routing API references, and reconcile with the real execution order in §4a. *Risk: none. Effort: low.* [docs, routing, pipeline]
18. **`pentest-phases.js` advertises itself as the single source of truth for pipeline depth but isn't** — most "optional" phases aren't wrapped in `phaseEnabled`, several always-on phases (0.6, 1.9, 3.085, 3.087, 3.4, 3.7) are absent from the manifest, and `0.5` has no implementation. Either wrap every optional phase (honest fix, behavior change, test per phase) or downgrade the claim and prune the manifest. *Risk: medium. Effort: medium.* [pipeline, personas]
19. **SETUP-LOCAL.md / BACKLOG.md drift:** `npm run verify` doesn't exist; the doc is polluted with non-OSS server vestiges (147 gates, mission-control, PM2, dead `/root/intel/CLAUDE.md` pointer); BACKLOG's concurrency-cap item is stale; BACKLOG.md + ORCHESTRATION.md are orphaned (nothing links them); `package.json` `repository.url` is empty; version pinned `1.0.0` despite active churn. *Risk: low. Effort: low.* [docs]

### Tier 4 — Duplication to consolidate (drift prevention)

20. **Collapse the many parallel copies** kept in lockstep only by tests (or not at all): model/cost extraction ×4 (`cli.js`, `sdk.js`, `run-agent-bridge.js`, `event-bus.js`) + `costFromEnvelope`; severity normalizers ×3 (`finding-schema`, `judge-verifier`, `emit-finding`); model fallback tables ×3 (`model-router`, `llm-model-resolver`, `grader`); the two Langfuse tracers; the two `url-extractor.js` modules; the two `STRIPPED_FIELDS` lists (already drifted 8 vs 11); the vuln-class taxonomy ×3 (planner/dedup/graph — divergence silently breaks cross-view correlation); the run-roster ×6; `finding_id` extraction ×2. *Risk: low-medium. Effort: low each, additive tests.* [runner, findings, routing, observability, verification, handoff, recon, personas]
21. **Consolidate the four recovery mechanisms** behind one state-reconciler with a single named-threshold config object + an explicit task/dispatch **status enum and transition table**. *Risk: high — load-bearing crash-recovery with incident history; do it behind characterization tests, incrementally.* [daemon]

### Tier 5 — Architectural refactors (high payoff, higher risk)

22. **Decompose `dispatchPentestParallel`** (~2,200 lines) into `phase(ctx)` functions + a driver loop over `PHASE_MANIFEST` honoring `phaseEnabled` — this also auto-fixes the manifest drift and is exactly the structure whose absence produced bug #1. *Risk: medium. Effort: high; stage incrementally behind tests.* [pipeline]
23. **Extract the event-bus lifecycle primitives** (`writeAtomic`/`acquireLock`/`withFileLock`/`updateTasksAtomic`/queue caps/state machine) into a testable module with exports — today `event-bus.js` exports nothing and has zero coverage on its most fragile, concurrency-sensitive code. *Risk: medium (preserve single-process synchronous assumptions). Effort: medium — mechanical move + characterization tests.* [daemon]
24. **Replace stringly-typed rate-limit/timeout signaling** (adapter message → bridge code → quota-manager regex, coupled by exact wording) with a structured `err.code/retryable/kind`. *Risk: medium (touches the retry spine). Effort: medium.* [runner]

### Tier 6 — Robustness, coverage & quality gaps

25. **Make finding production deterministic, not regex/LLM-fragile:** `auditor-validated-builder` greps the first `curl` line and has broken twice (em-dash-only `VERDICT_RE` → silently empties `VALIDATED-FINDINGS`, the reason for the GATE-125 quarantine band-aid); `normalizeCodeReviewFindings` pays a whole AUDITOR LLM call just to reshape an already-structured table (drift → zero white-box findings in the merge). Have AUDITOR emit JSONL directly. *Risk: medium (core producer). Effort: medium.* [evidence, white-box]
26. **Code-enforce severity caps** — wire `evidence-completeness.composeAllCaps` into AUDITOR post-processing (or delete the prompt duplication); have the judge write judged severity back into the canonical findings SCRIBE consumes instead of relying on prompt compliance. *Risk: medium (changes real severities; preserve `severity_original`). Effort: medium.* [evidence, pipeline]
27. **Fire-and-forget phases race their consumers** — Phase 1.6 JS-bundle (its endpoints are *never* appended to `pentest-endpoints` despite the header claim; only a 3000-char slice reaches the fingerprint prompt, racily), 3.07 evidence-capture, 3.08 active-poc. Await (or await-with-cap) at the consumption points. *Risk: low. Effort: low-medium (adds latency).* [pipeline, verification]
28. **Coverage gaps in the default OSS run:** only 9 of 15 documented pentest specialists ship in `FALLBACK_PENTEST_SPECIALISTS`; code-review defaults to only `access-control`+`xss` (sqli/ssrf/rce have null modules/catalogs); Phase 2 assesses only the first 6 features by *discovery* order, ignoring the ranked queue it just built. *Risk: medium (cost/time). Effort: medium.* [personas, white-box]
29. **Test coverage holes:** un-skip `grader.test.js` (bun-only) and a fast `browser-verifier` smoke test; add tests for `feedback-loop`/`memory-ranker`, `target-resolver`/`nmap-scan`, and the daemon locks/queue/recovery; the auto-skipped handoff tests are why the dead-target regression went unnoticed. *Risk: low. Effort: medium.* [grading, verification, learning, recon, daemon]
30. **Learning-loop correctness:** unify the `lessons.md` format (writers use h3+META, the ranker parses h2 → rich metadata discarded); make DISPROVEN capture deterministic (today it depends on the LLM voluntarily echoing it); fix `updateLessonEffectiveness` (bumps *every* lesson, not the injected ones). *Risk: low-medium. Effort: medium.* [learning]
31. **Harden the browser AST guard** against computed/dynamic property access (`window['fetch']`, `window['fe'+'tch']`, `Reflect.get(window,'fetch')`) and add a regression test for the executor's `(() => (EXPR))()` wrap coupling — *(uncertain: bypasses confirmed by code/test reading, not executed — node_modules absent in the checkout).* *Risk: low (LLM-only input today). Effort: low-medium.* [verification]
32. **Smaller ops fixes:** dead zero-findings Telegram alert (`zero_finding_alert` vs `zero_findings` key mismatch); finish or remove the half-wired daemon Langfuse span/trace lifecycle; stale notification deep-link (`agent.n8nn8n.com`); avoid re-reading the whole `ACTIVITY-LOG` on every 2.5s dashboard poll; prune the dead code-review dispatch UI; restrict `/api/report`+`/api/logs` exposure of 0600 credential-bearing briefs. *Risk: low. Effort: low.* [observability]

**Suggested sequencing for the push:** clear **Tier 0** first (bug #1 and the RED test gate are prerequisites for trusting any further work), then **Tier 1** (invariant/safety fixes), then run the large **Tier 2** dead-code sweep (low risk, shrinks the surface dramatically and makes Tier 5 refactors tractable), fixing **Tier 3** docs alongside so the next contributor isn't misled. Tier 4–6 are the sustained-quality backlog.