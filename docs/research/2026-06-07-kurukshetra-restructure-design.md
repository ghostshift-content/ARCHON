# Kurukshetra Future-Proof Restructure — Final Design

**Date:** 2026-06-07 · **Status:** DESIGN — awaiting owner approval · **No code changed.**
**Method:** 3 competing designs (minimal-pragmatist, framework-purist, state-separation) judged by 3 adversarial lenses (breakage, future, KISS). Winner by majority: **state-separation** (2/3 verdicts). framework-purist rejected by all 3 judges (fatal flaws — see §5). Hardened with grafts from both losers.

**The thesis:** the move feels scary because runtime state is welded into code dirs, not because of the move. Verified ground truth — ~962–971 git-tracked `memory/*` files, ~1364 files dirty in `git status` right now, `var/` already gitignored. Separate state first, then nesting personas under squads becomes the *least* scary step because the plugin folder is finally a thin, copyable, stateless code unit.

---

## 1. TARGET LAYOUT (end state)

```
/root/agents/                          # PURE CODE + PROMPTS — git-clean, zero per-task drift
├── event-bus.js                       # daemon entry (PM2 → here; NEVER moves)
├── paths.js                           # NEW — THE single resolver chokepoint (Phase 1)
│     # personaCode(name)  → code dir (SOUL.md + skills/)        [pre-eviction == personaDir]
│     # personaState(name) → STATE_ROOT/<name>/ (memory, recon)  [distinct accessor day 1]
│     # soulPath · skillsDir · squadDir · squadPolicyPath · a2aCapsDir · promptsDir
│     # reads layout.config.json → one named-mode field flips physical layout
├── layout.config.json                 # NEW — { personaMode: legacy|nested, stateMode: inline|evicted }
├── verify-framework.js                # +GATE-121 (no-raw-literal) +GATE-122 (no-dup-persona)
│                                       #  48 absolute requires of agents/*.js helpers UNCHANGED
├── squad-framework.js  model-*.js  *-dispatcher.js  prompt-renderer.js
├── memory-ranker.js  feedback-loop.js  # lessons.md writes → paths.personaState(name)
│
├── squads/                            # SQUADS-AS-PLUGINS — the §③ future-proof home (Phase 3)
│   ├── pentest/
│   │   ├── squad.json                 # ← agents/squads/pentest/squad.json (GATE-101 operational)
│   │   ├── policy.js                  # ← agents/squad-policy/pentest.js (GATE-81/84; filename==squad)
│   │   ├── capabilities.json          # ← TOP-LEVEL squads/pentest/capabilities.json (GATE-64 A2A)
│   │   ├── eval/                      # NEW — fills broken evalPath (was → nonexistent agents/KRISHNA/eval/)
│   │   └── agents/                    # personas nest HERE, THIN: SOUL.md + skills/ ONLY
│   │       ├── krishna/ (leader)  arjun/ rudra/ bheem/ karna/ nakul/ sahdev/
│   │       ├── draupadi/ abhimanyu/ eklavya/ satyaki/ shikhandi/ yuyutsu/ kritavarma/
│   │       └── dharma/                # pentest specialist per CODE (squadId=pentest-squad), not doc
│   ├── stocks/        { squad.json, policy.js, eval/, agents/{chanakya,bhishma,…} }
│   ├── cloud-security/{ squad.json, policy.js, capabilities.json, eval/, agents/{varuna,agni,kubera,mitra,soma} }
│   ├── network-pentest/{ squad.json, policy.js, eval/, agents/{shalya,indra,ghatotkacha} }  # GHATOTKACHA's ONE home
│   └── code-review/   { squad.json, policy.js, eval/, agents/{vibhishana,virata,…} }
│
├── _universal/                       # cross-squad agents — ONE physical home, served to all squads
│   ├── kripa/      (validator — buildKripa* are squad-parameterized)
│   ├── vyasa/      (reporter   — buildVyasa* are squad-parameterized)
│   ├── dharmaraj/  (judge      — VERIFICATION_AGENT, Phase 3.9, ALL squads)
│   └── rof/        (main-squad leader)         # sanjay = NO dir (router, never a subprocess)
│                                               # squad refs by AGENTS.JSON squadId, NOT by symlink
│
├── agents/                           # framework helper MODULES — UNCHANGED PATH (keeps 48 requires green)
│   ├── runner/  episode-record.js  learning-loop.js  auto-applier.js  quality-tracker.js
│   ├── phase-envelope.js  suppression-ledger.js  goal-evaluator.js  squad-config-loader.js
│   └── (squads/ + squad-policy/ contents MOVED OUT in Phase 3; loaders repointed via paths.js)
│
├── prompts/  scripts/  docs/  common/   # UNCHANGED
├── var/state/agents/<name>/             # ← EVICTED per-agent state (Phase 2); var/ already .gitignored
│   └── episodes/  grades.json  lessons.md  recon/
└── shared/                              # was empty → DELETE
                                         # NO compat symlink farm anywhere (purist's farm rejected — §5)

/root/intel/                           # CENTRAL runtime state — UNCHANGED, already correct
├── episodes/episodes.jsonl  quality.jsonl  suppression-ledger.jsonl  verification-log.jsonl
└── squad-memory-<ns>.json  grader-config.json

/root/mission-control/data/squads.json # 3rd "squads" concept — DO NOT TOUCH (read by event-bus:359 + supervisor:28)
```

---

## 2. WHY THIS SHAPE

- **Resolver chokepoint is the keystone, not the move.** `paths.js` converts ~50 scattered `/root/agents/<persona>` literals (55 in event-bus, 48 in verify, **~30 inside LLM prompt strings that fail SILENTLY**) into ONE swappable file. Every subsequent physical move becomes a one-field flip in `layout.config.json` + `pm2 reload`, instantly git-revertable. Without this, every later phase is 50 scary edits instead of one.

- **Shared/universal agents get exactly ONE physical home, gate-enforced.** `_universal/{kripa,vyasa,dharmaraj,rof}` is a first-class sibling of real squads — their prompt builders are already squad-parameterized (`buildKripa*`/`buildVyasa*` take `squad` as an arg; DHARMARAJ runs Phase 3.9 for all squads), so filing them under one domain would lie about topology. Ownership stays in `agents.json` (`squadId`); `paths.js` resolves the home from `squadId` via an OWNERSHIP map — folder tree and roster can never silently diverge. **GATE-122 (NO-DUP-PERSONA)** asserts each persona name resolves to exactly one physical dir. GHATOTKACHA → one home `squads/network-pentest/agents/` (per `agents.json` + `network-dispatcher.js:76`); its pentest "membership" stays a prompt-string escalation marker, not a second copy. DHARMA → `squads/pentest/agents/` (honor the CODE: `squadId=pentest-squad`; CLAUDE.md's "universal compliance" is stale doc — flag, don't act).

- **Runtime state is evicted from code dirs — this IS the future-proofing.** Single verified writer `writePostTaskMemory` (event-bus.js:1660-1717) + 3 `lessons.md` appenders (memory-ranker:144/292, feedback-loop:219). SOUL.md/IDENTITY.md are read-only (learning loop barred at event-bus.js:7179). State moves to `var/state/agents/<name>/` (already gitignored). After eviction, `git status` is permanently clean and auto-applier stops fighting per-task churn. A plugin you can drop in/pull out is **impossible** while runtime state is welded into it — so eviction is the precondition for squads-as-plugins, not an optional cleanup.

- **The gate harness and PM2 entry never move.** `agents/runner/`, `agents/*.js` helpers and the 48 absolute `require('/root/agents/agents/...')` in `verify-framework.js` are squad-AGNOSTIC infra with zero persona coupling — they stay put (this is the exact line framework-purist crossed and got killed for). `event-bus.js` stays at `/root/agents/event-bus.js`, so `ecosystem.config.js` and every rollback `pm2 reload` are stable.

---

## 3. MIGRATION PLAN

Operational invariants for **every** cutover: (a) queue-idle confirmed (dispatch-queue empty + no in-progress tasks), (b) `LEARNING_AUTO=off` for the window (auto-applier.js:166 does `git add -C AGENTS_DIR`, :257 relativizes SOUL against AGENTS_DIR — its auto-commit must not fire mid-move), (c) `pm2 reload event-bus` (+ restart `mc` for Phases 2/3), (d) each phase ends **120/120 + its new gates green**, (e) each phase is one revert unit on a non-master branch.

### Phase 0 — Baseline & safety net *(no code change, ~0.5 day)*
Capture `node verify-framework.js` = 120/120 golden baseline; `git tag pre-restructure`; confirm queue-idle detection; write `paths.js` contract spec + rollback runbook.
**Gate:** 120/120 + clean tag exists. **Rollback:** nothing to revert.

### Phase 1 — Resolver chokepoint *(NO physical move — the keystone, ~1–1.5 days)*
Create `paths.js` returning **byte-identical** current paths (`personaCode`/`personaState` both point at today's `personaDir` base via `layout.config.json` modes `legacy`+`inline`). Replace all ~50 event-bus literals + **the ~30 in-prompt `cat /root/agents/...` strings** (render via paths so they can't drift silently) + memory-ranker/feedback-loop/prompt-renderer literals. Opportunistically fix the dead `readSoulContent` 2-element-identical fallback (event-bus.js:1573-1574).
**Gate:** **GATE-121** — greps event-bus + 5 helpers for ANY raw `/root/agents/<persona>` literal outside `paths.js`, FAILS if one survives (whitelist `/root/agents/squads`, `/prompts`, `ecosystem`).
**Acceptance:** resolver is a pure no-op — output strings byte-identical to pre-Phase-1; single-commit revert.
**Cutover:** queue-idle + `pm2 reload event-bus`. **Rollback:** `git revert` one commit.

### Phase 2 — State eviction *(per-agent state leaves code dirs, ~1.5–2 days)*
Point `paths.personaState()` at `var/state/agents/<name>/`. Flip the 5 writer sites (`writePostTaskMemory`, memory-ranker ×2, feedback-loop, auto-applier lessons path) + 5 mission-control TS readers (agent-versioning.ts, agents/[id] route, skill-health, feedback, memory). `git rm --cached` the ~962 tracked memory + 13 recon files; **copy** (not move) live data into `var/state/`; commit. Persona dirs become `{SOUL.md, skills/}` only.
**Gate:** **GATE-STATE-OUT-OF-GIT** (state root gitignored, no `grades.json` under persona code dirs); 120/120 unchanged.
**Hard smoke check:** dispatch one task per squad; assert episode/grades/lessons land in `var/state/` AND that **SOUL content actually appears in the rendered prompt / live transcript** (grep the agent's tool calls for a successful SOUL read) — not merely that the file exists. Any grade regression = rollback trigger.
**Cutover:** queue-idle + `LEARNING_AUTO=off` + `pm2 reload event-bus` + restart `mc`.
**Rollback:** flip `stateMode` back + `git restore` un-cached files. Data preserved (copy-not-move) — zero loss.

### Phase 3 — Squad nesting *(personas move under squads/ — ONE SQUAD AT A TIME, 5 sub-cutovers, ~3–4 days)*
Per squad: `git mv` squad-owned personas → `squads/<squad>/agents/<name>/`; universals → `_universal/<name>/`. Consolidate the squad's config family: `agents/squads/<sq>/squad.json` + `agents/squad-policy/<sq>.js` + top-level `squads/<sq>/capabilities.json` → `squads/<sq>/{squad.json,policy.js,capabilities.json}`. Update `paths.js` OWNERSHIP map (derived from `agents.json` squadId), `squad-config-loader` (`__dirname`-relative — mostly auto-follows), **auto-applier write/git-stage paths**, and the 4 top-level-squads readers (handoff-resolver:37, process-handoff:150, smoke-handoff:61, event-bus:10952). Create real `eval/` dirs, fixing GATE-101's broken evalPath.

**MUST-NOT-FORGET lockstep (the single riskiest step):** in the SAME commit as each squad move, repoint **GATE-118** (verify-framework.js:3106 reads 8 hardcoded persona SOUL paths) through `paths.personaCode(name)`, and repoint auto-applier's relative-stage path. GATE-118 fails LOUDLY if forgotten (good); a forgotten auto-applier repoint stages wrong paths silently (why `LEARNING_AUTO=off` is mandatory this phase).
**Flag discipline:** the nest move + the `personaMode: legacy→nested` flip live in the SAME revert unit — rollback is a flag flip + `pm2 reload` in <60s.
**Gate:** 120/120 after each squad incl. GATE-64/78/81/84/101/118 + **GATE-122 (NO-DUP-PERSONA)**; A2A handoff smoke test passes.
**Rollback:** `git revert` that squad's commit — other 4 squads undisturbed.

### Phase 4 — Seal & document *(~0.5 day)*
Delete empty `shared/`. Update ecosystem comment, CLAUDE.md roster (fix GHATOTKACHA / DHARMA / KRIPA-VYASA topology to match code), STRUCTURE.md. Add **GATE-PLUGIN-SHAPE** (each squad has `squad.json`+`policy.js`+`eval/`+`agents/`).
**Gate:** 120/120 + plugin-shape gate. **Rollback:** doc-only, trivial.

**Total: ~8–11 working days, fully soakable between phases.**

---

## 4. WHAT WE DELIBERATELY DON'T DO

- **No `core/` rename** (agents/runner→core/runner etc.) — breaks the 48 absolute requires the gate harness needs to even RUN; zero readability rent. *(This is what killed framework-purist.)*
- **No compat symlink farm** — its "zero impact" rests on unverified SDK `addDirs` symlink traversal (event-bus.js:594, :9763 grant the OLD literal path) AND it masks GATE-118 into false-green.
- **No §③ contract buildout** (`judgeRubric()`, `reportScrub()`, per-squad `agents/*.md` prompts, `hooks/`, `.mcp.json`) — a feature project, not a folder move. We create the shell + `eval/` dir so it CAN be filled later.
- **No touching `/root/intel` central state** — already correctly in the data layer, already git-clean.
- **No touching `mission-control/data/squads.json`** (the 3rd "squads" concept, read by event-bus:359 + supervisor:28) — unrelated dashboard metadata; explicit do-not-touch fence.
- **No moving framework helper modules or `event-bus.js`** — keeps PM2 entry + 48 verify requires stable.
- **No merging per-agent `.md` state with central `.jsonl`** — different format/granularity/consumer. Data-model decision, not structure.
- **No deduping FALLBACK_* rosters / no normalizing heterogeneous persona shape** — correctness cleanups, flagged for follow-up, not entangled with the move.

---

## 5. FATAL FLAWS THE JUDGES FOUND — AND THE DODGE

| # | Flaw (design) | Dodge in final design |
|---|---|---|
| F1 | **purist:** `core/` rename bricks the gate harness — 18+ absolute `require('/root/agents/agents/...')` in verify-framework are Node `require()`, NOT path resolution; `paths.js` can't intercept them | Helper modules **stay at `agents/`**. The 48 requires are never touched |
| F2 | **purist:** symlink farm keystone — SDK `addDirs` sandbox grants the OLD path (event-bus.js:594/:9763) and may NOT follow a symlink to a non-granted realpath → silent loss of SOUL/skills read | **No symlink farm.** `addDirs` grants rewritten through `paths.js` to the real new path in lockstep |
| F3 | **purist:** GATE-118 stays GREEN via symlink whether or not consumers migrated → false-confidence 120/120 on a half-broken daemon; Phase 6 (delete farm) irreversible | No symlink → GATE-118 fails LOUDLY if not repointed. No irreversible terminal phase |
| F4 | **purist:** Phase 2 hand-builds the per-agent memory lane THE-FRAMEWORK.md:104 says to REPLACE with native Dreaming | We only **relocate** existing state. `personaState()` is the swap seam — Dreaming adoption later = one-file resolver swap |
| F5 | **SILENT-FAILURE class (all 3 judges, highest):** ~30 in-prompt `cat /root/agents/<persona>/...` strings run in the agent's bash, invisible to Node, fail with no exception | Phase 1 routes ALL through `paths.js` render; GATE-121 fails build on any survivor; Phase 2/3 smoke asserts SOUL content appears in rendered transcript |
| F6 | **minimal:** refuses squad-nesting → does the persona move TWICE | Nest directly into `squads/<squad>/agents/` in Phase 3. One destination, no intermediate hop |
| F7 | **minimal:** leaves ~962 tracked memory files dirtying the repo; auto-applier keeps fighting per-task churn | Phase 2 eviction is the load-bearing fix — `git status` permanently clean |
| F8 | **state-separation (own gap):** Phase 3 lockstep fragility — GATE-118 + auto-applier + 4 readers must repoint in the SAME commit | Explicit MUST-NOT-FORGET gate-hard step, per-squad commit, `LEARNING_AUTO=off` window |

---

## 6. OPEN DECISIONS FOR THE OWNER

1. **STATE_ROOT: `var/state/agents/<name>/` (default) vs `/root/intel/agent-state/<name>/`** — var/state is already gitignored + adjacent to code; intel parallels existing central state and survives a repo-root move. Pick before Phase 2.
2. **Native "Dreaming" adoption behind the remember port** — post-restructure decision, not a blocker; eviction is correct either way. Flagged so it isn't forgotten.
3. **DHARMA ownership — CODE (pentest, default) or DOC (universal)?** — if owner wants universal, that's a roster change in `agents.json` FIRST, then `_universal/`. Must not be a silent restructure side-effect.
4. **Phase 3 canary order** — start with the squad with fewest in-prompt refs + least-active dispatch profile; validate the playbook before touching pentest (most personas, most prompt strings).

Relevant execution files: `event-bus.js`, `verify-framework.js`, `agents/auto-applier.js`, `agents/squad-config-loader.js`, `memory-ranker.js`, `feedback-loop.js`, `prompt-renderer.js`, `/root/mission-control/data/agents.json`, `/root/mission-control/data/squads.json` (do-not-touch), 5 mission-control TS readers.
