# ARCHON — PROGRESS (living doc)

> **New session? Start here.** Ye file framework ki current haalat, kya ban chuka hai, aur aage kya drill hai — sab ek jagah. Jab bhi koi bada item complete/start ho, ise update karo (stale progress doc < no progress doc).

**Last updated:** 2026-06-08 · **Gates:** 139/139 green · **Daemon:** event-bus live on pure-SDK · **Layout:** personas nested in squads, state evicted

---

## 🩺 30-second health check (har session ke shuru mein)

```bash
node /root/agents/verify-framework.js          # ~2min → RESULT: 145/145 gates passed
node /root/agents/agents/changelog-watcher.js breaks-only   # 0 alerts expected
pm2 list                                       # event-bus, supervisor, telegram-relay, mc = online
```

Agar gates fail ya break alert → pehle wo fix karo, naya kaam baad mein.

---

## ✅ DONE — naya framework (2026-06-04/05 build sprint)

| # | System | File | Gate | Kya karta hai |
|---|---|---|---|---|
| 1 | **Pure-SDK cutover** | `agents/runner/` (default adapter=`sdk`) | 94–97 | Saare 5 `claude -p` spawn retired. Rollback: `ADAPTER=cli` |
| 2 | **Typed phase envelope** | `agents/agents/phase-envelope.js` | 98 | Inter-phase contract — silent-drop/stale-file class ka root-cause fix |
| 3 | **Suppression ledger** | `agents/agents/suppression-ledger.js` | 99 | Har High/Critical downweight logged + manual-review queue (false-negative visibility) |
| 4 | **Quality tracker** | `agents/agents/quality-tracker.js` | 100 | Per-squad pass-rate/cost/grade → `/root/intel/quality.jsonl` |
| 5 | **Squad configs** | `agents/squads/*/squad.json` (5 files) | 101 | Model tier/effort/severity/caps per squad — hardcoded knobs khatam |
| 6 | **Changelog watcher** | `agents/changelog-watcher.js` | 102 | Break-detection (SDK drift, adapter drift, binary missing) + weekly digest |
| 7 | **Learning loop** | `agents/agents/episode-record.js` + `learning-loop.js` | 103 | OBSERVE→DISTILL→PROPOSE. **Kabhi auto-apply nahi** — `requiresHumanTap:true` gate-locked |
| 8 | **Goal evaluator** | `agents/agents/goal-evaluator.js` | 104 | Oracle-anchored convergence (heuristic + oracle second opinion) |
| 9 | **Goal evaluator = DEFAULT** | event-bus.js wire (commit `e26f21a`) | **105** | EARLY_EXIT se pehle oracle se poochta hai — galat give-up rokta hai. Fail-soft |
| 10 | **Full-auto learning loop** | `agents/auto-applier.js` | **106** | Human-tap removed. Kill-switch `LEARNING_AUTO=off`, git-commit per apply, burst-cap 5/24h, quality watchdog auto-revert |
| 11 | **Dashboard spec v2** | `docs/research/2026-06-04-dashboard-redesign-spec.md` | — | 6 views incl. INBOX. **Spec ready, code nahi bana** |

Sab main branch pe pushed. Quality proof: ITC run (SDK) 62/70 vs old framework 61/70 — transport se quality same, cost visibility better.

---

## ✅ Architecture upgrades (2026-06-05 sprint 2, GATE-107→111)

| # | What fixed | Gate | Impact |
|---|---|---|---|
| P0 Bug | episode gradeScore/findingCount/suppressionCount hardcoded 0 | 108 | Learning loop now gets real signals |
| P0 Bug | updateTaskGrade retroactively patches specialist episodes after gradeTask() | 108 | Grade data flows to learning loop |
| Capability | Extended thinking: auto-enable at effort=max in SDK adapter | 107 | Agents get deep reasoning on complex targets |
| Capability | Live findings cap: 10→50 per specialist | — | Batch 2+ agents see full context |
| Capability | Oracle richer context: target+squad+goal+phases in STOP/CONTINUE | — | Oracle from coin-flip → informed decision |
| Grader | Structured sliding window: findings-first + head/tail | 109 | Grader sees full run, not just tail |
| Learning | soul_md_append: SOUL.md lessons for ≥5 recurring failures | 110 | Loop now improves agent prompts |
| Reflexion | Batch 1 critique injected into batch 2+ specialist prompts | 111 | Agents don't repeat, they chain + gap-fill |

**Current state: 111/111 gates, commit `ec7a008`, both repos pushed, daemon reloaded (restart 365)**

---

## ✅ Final sprint (2026-06-05 sprint 3, GATE-112→115)

| Gate | System | What |
|---|---|---|
| 112 | Adaptive 2-wave batching | 4 sequential → 2 parallel waves (~65min → ~35min wall time) |
| 113 | Prompt caching | --exclude-dynamic-system-prompt-sections default ON, cache savings in ledger |
| 114 | 6 bug fixes (architecture review) | Conditional reflexion, gold-set replay fix, auto-applier ceiling fallback, episode waveNumber, high-suppression pattern |
| 115 | 5 new systems (final sprint) | Per-agent override, Phase 2.5 fast-verify, zero-finding alert, dashboard sync, grade-AUDITOR correlation |

**commit `6e45060` — 115/115 gates — daemon restart 369 — both repos pushed**

---

## ✅ Quality sprint (2026-06-06, GATE-116→120)

| Gate | System | What |
|---|---|---|
| 116 | Quality sprint | ARBITER evidence fix, confidence+reproduction fields, challenger agent (Phase 3.055), contradiction detector (Phase 2.9) |
| 117 | Multi-judge consensus | 3-judge majority vote for High/Critical ARBITER decisions (+17.9% proven by research) |
| 118 | Agent SOUL quality | All key agents full SOUL.md (not identity cards) — VIPER identity fix, VAULT/TRACER upgraded from placeholders, FORGE SSTI chains, RANGER WebSocket/CSP |
| 119 | Failure-content-aware distill | Learning loop classifies failure cause → targeted lessons, not generic strings + watchdog silent-pass fix |
| 120 | Chain-evidence bridge | Phase 3.6 curl results annotate VALIDATED-FINDINGS (`chain_verified`/`chain_evidence`) → ARBITER Stage C judges on real HTTP evidence, not text alone |

Also: hardcoded fallback model opus-4-7 → opus-4-8 in model-router.js (`4f1359e`).

**120/120 gates — daemon restart 372 — ITC stocks run (2026-06-06): grade 97% (36/37), $30.12**

---

## ✅ Restructure COMPLETE (2026-06-07/08, GATE-121+122) — personas nested in squads, state evicted

Design doc: `docs/research/2026-06-07-archon-restructure-design.md` (3 designers + 3 adversarial judges, winner: state-separation). Target: personas → `squads/<sq>/agents/`, universals → `_universal/`, runtime state → `var/state/agents/`.

| Phase | Status | What |
|---|---|---|
| 0 Baseline | ✅ | `pre-restructure` git tag, 120/120 golden, queue-idle confirmed |
| 1 Resolver | ✅ | `paths.js` + `layout.config.json` + `ownership.json` — ALL persona-path literals route through it (event-bus, memory-ranker, feedback-loop, GATE-118, learning-loop, +SDK addDirs). GATE-121. |
| 2 State eviction | ✅ | `stateMode: evicted` → `var/state/agents/<name>/`. 967 memory files `git rm --cached` + 50 state subdirs evicted. Persona dirs now thin (SOUL+skills+cards). |
| 3 Squad nesting | ✅ | 49 personas `git mv` → `squads/<sq>/agents/<name>` + universals → `_universal/agents/`. `personaMode: nested` via `ownership.json`. GATE-122 (no-dup + plugin shape). |
| 4 Seal | ✅ | GATE-122, empty `shared/` removed, STRUCTURE.md rewritten, mc resolver (`lib/agent-paths.ts`) + 6 readers repointed + rebuilt. |

**mission-control:** rebuilt with shared resolver `lib/agent-paths.ts` (mirrors paths.js, reads same runtime config). 6 readers repointed (agent-versioning, agents/[id] route, memory, skill-health, feedback, pentest page). Dashboard resolves personas at new squad homes — verified (12 compiled chunks read ownership.json; daemon reads SOUL from `squads/pentest/agents/scout`).

**Cutover model (the win):** physical layout is now driven by `layout.config.json` (personaMode/stateMode) + `ownership.json`, read at RUNTIME by both daemon + dashboard. Moving the layout again = a config flip + `pm2 reload`, no code change, fail-soft fallback to flat. `pre-restructure` git tag = rollback floor.

**⚠️ Eviction backup gap:** `var/state/` is gitignored — evicted lessons no longer pushed to GitHub (survive in git history + `pre-restructure` tag). New lessons accrue only on-box. Off-box backup = future job if needed.

**Deferred (Phase 3b, documented):** squad.json (still `agents/squads/`) + squad-policy (still `agents/squad-policy/`) consolidation into `squads/<sq>/` — same resolver pattern, deferred to bound blast radius.

---

## ✅ Safety + correctness fixes (2026-06-08, GATE-123→127)

| Gate | Fix | What was wrong |
|---|---|---|
| 123 | Adapter-label truth | recordRunQuality logged `\|\| 'cli'` but runner defaults `'sdk'` → every SDK run mislabeled cli, corrupting June-15 billing signal. Single source: `resolvedAdapterName()`. |
| 124 | Suppression counterweight LIVE | `logManualReviewNeeded` was built but never called. Phase 3.075 now logs every downgrade + escalates high-conviction/low-evidence (by ORIGINAL severity) to manual-review-queue. |
| 125 | phase-envelope wired | Had ZERO prod call sites. AUDITOR→VALIDATED seam now typed + quarantines LOUD when AUDITOR had verdicts but 0 reached VALIDATED-FINDINGS (the VERDICT_RE silent-drop class). |
| 126 | Auto-apply safety perimeter | Full-auto loop (GATE-106) could write any path. Now structurally barred (fail-closed) from judge/verifier/gates/reward/eval + judge persona. Does NOT remove auto-apply. |
| 127 | Suppression recall MEASURED | No number for "how often is a planted real bug suppressed?". `scripts/recall-probe.js` + `eval/recall-fixtures.jsonl` → **100% recall, 0 silent drops** across all 3 profiles. The quality metric of record (deterministic suppression layer). |

Also: `scripts/backup-agent-state.sh` (var/state off-git floor, cron-ready) · meter-probe usage-ledger refreshed for June-15.

## ✅ Audit-driven fixes (2026-06-08, GATE-128 + cleanups)

5-auditor adversarial sweep → fixed the real findings:
- **P1 (real regression from restructure):** repair/learning prompts READ `memory/*` from `personaCode` (squads/.../memory — empty under evicted) while writes LAND in `personaState` (var/state). Skill-repair agents were reading empty memory + patching blind. Fixed event-bus.js:6917/7189 → personaState. **GATE-128** locks read==write.
- **P2:** `paths.js personaCode('SCOUT')` → broken `/root/agents/SCOUT` (daemon/dashboard diverged on uppercase). Lowercased paths.js to match agent-paths.ts + ownership. GATE-128 casing probe.
- **P3:** cloud/network dispatchers silently swallowed malformed chain JSON (looked like 0 chains). Now logs LOUD.
- **P4:** `manual-review-queue.jsonl` was write-only (escalations piled up unread). Built `agents/review-queue.js` (list/count/resolve). GATE-124 extended to require the reader.
- **Doc drift:** gate counts → 128 (CLAUDE.md ×2, STRUCTURE.md), `grade` schema scalar→object in intel/CLAUDE.md (Gulf Oil bug class), pentest persona row (+4 agents, GHATOTKACHA→network only, SENTRY=pentest not universal), MAYA scaffolded, dashboard-spec Inbox-B → correct file.

**Jay — paste to enable the 2 dormant jobs (cron blocked from auto-add):**
```
0 9 * * * node /root/agents/agents/changelog-watcher.js breaks-only >> /tmp/changelog-watcher.log 2>&1
0 */6 * * * /root/agents/scripts/backup-agent-state.sh >> /root/intel/backup-agent-state.log 2>&1
```

## ✅ Production-ready pass (2026-06-08, GATE-129/130) — the 3 "owner decisions" resolved by fixing

- **🔴 BIG BUG — learning loop was dead-on-arrival (GATE-129).** `emitEpisode` (in `spawnAgent`) referenced `_agentWaveMap`/`_agentReflexionMap` which live in `dispatchPentestParallel`'s scope → `ReferenceError` swallowed by a silent `catch {}` → **episodes.jsonl never written for ANY squad** since the OBSERVE stack was built. The whole learning loop had zero data. Fixed: source from `opts`, catch now LOUD. Episodes will flow on the next dispatch.
- **squad-config-loader WIRED (GATE-130).** Was fully dead (squad.json validated but never read; auto-applier's `squad_config_patch` a runtime no-op). Now `caps.maxSpecialists` is applied at dispatch (`_applySquadCap`, fail-soft, only trims). squad.json is live + auto-applier effective. (modelTier/effort/severityProfile stay on their live sources — model-router/program_type — wiring those would change routing; left advisory.)
- **Learning loop status (honest):** OBSERVE now writes episodes automatically; DISTILL/PROPOSE (`learning-loop.js`) runs on tap/cron. It's a **long bet** (~9 recurring misses to fire) — data-gathering is live, distillation is human-triggered. Cron line in the box above (blocked from auto-add).
- **June-15 pool (honest, external):** meter-probe's `POOL_MAP` is a documented-provisional policy guess (both cli+sdk → capped); the actual pool *billing* is only knowable from the Anthropic dashboard. GATE-123 made the adapter *label* truthful so the usage-ledger data is now trustworthy. **Verify against the billing dashboard after June-15** — not a code bug, an external check.

**Still genuinely OPEN (your call, not bugs):**
- Dashboard redesign — spec ready (`docs/research/2026-06-04-dashboard-redesign-spec.md`, Inbox-B now points at the right file), no code. Build read-only API first, start with Health view.
- Phase 3b — squad.json/policy folder consolidation into `squads/<sq>/` (optional tidy).
- **June-15 billing (7 days):** adapter labeling now truthful + ledger fresh → re-run `meter-probe probe` near June-15 and decide API-key vs subscription. *(data now trustworthy)*
- **Auto-apply (GATE-106):** perimeter added, but full-auto-without-human-tap is still your deliberate call — flagged, your decision.
- **Phase 3b (deferred):** squad.json + squad-policy consolidation into `squads/<sq>/` — optional tidy, real GATE-64/101/81/84 coupling, held off (risk > reward right now).
- **LLM-layer recall:** GATE-127 covers the deterministic suppression layer; AUDITOR/judge-layer recall needs real planted-bug dispatches (future).

## 🔜 NEXT — priority order

### 1. Dashboard redesign IMPLEMENT drill (biggest pending item)
- Spec ready: `docs/research/2026-06-04-dashboard-redesign-spec.md` (v2)
- **Flow:** Jay spec ka "Ask for Claude.ai" section Claude.ai design session mein le jayega → design banega → wapas laake `/root/mission-control/` mein code karenge
- 6 views: Home, Task View, **Inbox (human-tap)**, Squads, History, Health
- Hard rule: Approve/Reject sirf gated CLI (`learning-loop.js`) se — UI kabhi jsonl direct na likhe

### 2. Learning loop ka pehla REAL cycle
- Abhi proposals = 0 (koi dispatch nahi hua naye observe ke baad)
- Agla real dispatch chalao (stock ya pentest) → episodes katenge → `node agents/learning-loop.js list` se pattern/proposal check karo
- Proposal aaye to Jay ko dikhana (approve/reject uska decision)

### 3. June-15 billing change watch
- `node agents/runner/meter-probe.js probe` se cli-vs-sdk pool data already recording
- June-15 ke baad probe दोबारा chala ke compare drill — pool inference shift hua ya nahi

### 4. Deferred (jaan-bujh ke, bugs nahi)
- **Dashboard sync gap** — direct queue drops `tasks.json`/`projects.json` backfill nahi karte (manual recipe documented in memory)
- **Routines/billing move** — plan mein tha, abhi zaroorat nahi
- **Legacy spawn code deletion** — cli adapter rollback floor hai, abhi mat hatao
- **grader.js env-spread** — medium, cutover ho gaya but cleanup baaki (GATE-94 note)

---

## 📍 Important paths (naye session ke liye map)

| Kya | Kahan |
|---|---|
| Framework root | `/root/agents/` (event-bus.js = main daemon, ~10K lines) |
| Architecture docs | `docs/research/2026-06-03-archon-START-HERE.md` → THE-FRAMEWORK.md |
| Dashboard spec v2 | `docs/research/2026-06-04-dashboard-redesign-spec.md` |
| Subtree rules | `/root/agents/CLAUDE.md` (orchestrator) + `/root/intel/CLAUDE.md` (data schemas) |
| Design system | `/root/mission-control/DESIGN.md` |
| Data layer | `/root/intel/` (dispatch-queue, quality.jsonl, episodes/, suppression-ledger.jsonl, learning-proposals.jsonl) |
| Cross-session memory | `/root/.claude/projects/-root/memory/MEMORY.md` |

## ⚠️ Standing rules (mat bhoolna)

- Daemon reload **sirf** event-bus.js ya required module change pe, **queue idle check ke baad** (`pm2 reload event-bus`)
- `git add -A` **kabhi nahi** (grades.json runtime drift) — specific files stage karo
- Naya invariant banao to **gate bhi banao** (GATE-122 next)
- **Persona/squad paths SIRF `paths.js` se** — raw `/root/agents/<persona>` literal = GATE-121 failure
- Model strings hardcode nahi — `modelRouter.resolve()`
- 1M-context model = usage credits; subscription ke liye standard Opus

---

## 📜 Changelog (recent → old)

- **2026-06-08 (ITC-run fixes):** GATE-132→135 from a live ITC validation run — (132) activity-stall watchdog kills "streaming-but-no-output" hangs at 22min not 45 (the veteran's recurring hang); (133) ungraded runs record null not grade-0 (was poisoning quality baseline + learning loop with fake failures); (134) stocks 2 waves of 3 (RAM-safe); (135) **recovery-loop cap** — auto-recover was re-running a completed task FOREVER (one ITC scan ran 6×, ~$100+ burned) because its tasks.json status stayed in-progress; now blocked if a report exists or after 2 attempts. 135/135.

- **2026-06-08 (src reorg):** Source tree reorganized — 33 root modules → `src/<category>/` (core/dispatch/pipeline/grading/learning/routing/safety/rendering/integrations/utils) + tools/; 6 anchors stay at root (PM2 entry points + gate harness + resolver). Deterministic migration rewrote 106 require edges; gate harness + 4 tests' non-require paths fixed by hand; GATE-131 locks the layout. 145/145, daemon reloaded clean (all 61 event-bus requires dry-load-verified first). README/STRUCTURE production-ready.
- **2026-06-08 (fixes):** GATE-123→130 — adapter-label truth, suppression counterweight LIVE, phase-envelope wired, auto-apply perimeter, recall metric, **dead episode pipeline revived** (emitEpisode ReferenceError → episodes.jsonl never written), squad-config wired, memory read/write split + casing parity, manual-review reader
- **2026-06-08:** Restructure COMPLETE — 49 personas nested into `squads/<sq>/agents/` + `_universal/agents/`, state evicted to `var/state/`, GATE-122, 122/122, mc rebuilt with shared resolver, both daemons reloaded clean
- **2026-06-07 (shaam):** Restructure Phase 0+1 — paths.js resolver chokepoint (GATE-121), 121/121, daemon reload clean (restart 373), design doc + STRUCTURE.md + var/artifacts quarantine
- **2026-06-07:** GATE-120 chain-evidence-bridge committed + docs refreshed to 120/120 + both repos pushed
- **2026-06-06:** Quality sprint GATE-116→120 (3-judge consensus, SOUL quality, failure-aware distill, chain-evidence bridge) + ITC stocks run 97%
- **2026-06-05:** GATE-105 goal-evaluator default wire + dashboard spec v2 (Inbox view) + 105/105 + daemon reload clean
- **2026-06-05 (raat):** B1–B8 build sprint — phases envelope/suppression/quality/squad-configs/changelog-watcher/learning-loop/goal-evaluator → 104/104
- **2026-06-04:** Pure-SDK cutover live (5/5 spawn sites), AgentRunner port, meter-probe first data, ITC quality-parity proof
- **2026-06-03:** Next-gen architecture design docs (START-HERE + THE-FRAMEWORK), inside-CC vision
