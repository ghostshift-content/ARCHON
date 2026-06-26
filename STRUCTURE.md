# /root/agents — Folder Structure Map

> **Restructure COMPLETE (2026-06-08).** Personas now live inside their squads; runtime state
> is evicted out of the code dirs. All path resolution goes through one chokepoint (`paths.js`),
> driven by runtime config (`layout.config.json` + `ownership.json`) that both the daemon and the
> dashboard read live — so the physical layout can move again with a config flip, no code change.
> Full design + rationale: `docs/research/2026-06-07-archon-restructure-design.md`.

## The layout

```
/root/agents/
├── event-bus.js                 # THE daemon (~11K lines, PM2). Persona paths via paths.js only.
├── paths.js                     # THE resolver chokepoint (GATE-121). personaCode/personaState/soulPath/…
├── layout.config.json           # { personaMode: nested, stateMode: evicted } — runtime cutover knobs
├── ownership.json               # persona name → squad home (runtime-read; nested mode)
├── verify-framework.js          # 145 gates. GATE-121 resolver, 122 persona-homes, 131 src-tree-layout.
│
├── squads/                      # SQUADS-AS-PLUGINS — each domain is a folder
│   ├── pentest/
│   │   ├── capabilities.json    # A2A handoff capabilities (GATE-64)
│   │   └── agents/              # ← personas live HERE now
│   │       ├── atlas/ (leader)  scout/ ranger/ relay/ drill/ viper/ gateway/ warden/
│   │       └── vault/ tracer/ keyring/ decoy/ ledger/ spectre/ forge/ sentry/
│   ├── stocks/agents/          { chanakya(leader) the veteran the analyst lakshmi narad saraswati shakuni surya vayu vidura vishnu }
│   ├── cloud-security/         { capabilities.json, agents/{varuna(leader) agni kubera mitra soma} }
│   ├── network-pentest/agents/ { shalya(leader) indra ghatotkacha }   # GHATOTKACHA's ONE home
│   ├── code-review/agents/     { curator(leader) marshal siphon cipher quill beacon breaker prober }
│   ├── red-team/agents/        { parashurama }
│   └── ai-security/agents/     { maya }
│
├── _universal/agents/           # cross-squad agents — ONE shared home (squad-parameterized)
│   ├── auditor/      (independent verifier — used by all squads w/ Phase 3)
│   ├── scribe/      (final reporter)
│   ├── arbiter/  (confidence-calibrated judge — Phase 3.9, all squads)
│   └── command/        (main-squad leader)        # nexus = router, no dir
│
├── agents/                      # framework helper MODULES (NOT personas — historical name)
│   ├── runner/  squads/<sq>/squad.json (GATE-101 operational config — see note)
│   ├── squad-policy/<sq>.js     (scope/severity adapters — GATE-81/84)
│   └── phase-envelope.js  suppression-ledger.js  goal-evaluator.js  learning-loop.js  auto-applier.js  …
│
├── var/state/agents/<name>/     # EVICTED runtime state (gitignored). memory/ recon/ reports/ …
│   └── memory/{lessons.md, grades.json, episodes/}
├── var/artifacts/               # quarantined evidence pngs / recon txt / old backups (gitignored)
├── prompts/  scripts/  docs/  common/
```

## The resolver contract (paths.js — mirror in mission-control/lib/agent-paths.ts)

| Accessor | Returns | Honors |
|---|---|---|
| `personaCode(name)` | SOUL.md + skills/ + identity cards home | `personaMode` + `ownership.json` |
| `personaState(name)` | memory/ recon/ sessions/ home | `stateMode` |
| `soulPath` `skillsDir` | derive from `personaCode` | — |
| `memoryDir` `lessonsPath` `sessionsDir` | derive from `personaState` | — |
| `a2aCapsDir()` | `squads/` (A2A capabilities root) | — |

**Cutover = config flip, no code change.** `layout.config.json` modes:
- `personaMode`: `legacy` (flat `/root/agents/<name>`) | `nested` (`<home>/agents/<name>` via ownership.json) — **currently nested**
- `stateMode`: `inline` (state in code dir) | `evicted` (`var/state/agents/<name>`) — **currently evicted**

Both resolvers mtime-cache the config and **fail-soft**: a missing nested dir falls back to the flat path, so a half-applied move never starves a SOUL/skill read. GATE-121 forbids raw persona-path literals outside `paths.js`; GATE-122 asserts every persona resolves to exactly one physical SOUL.md (no dups) and the squad-plugin shape holds.

## Source layout — `src/<category>/` (reorg 2026-06-08, GATE-131)

The repo root holds ONLY the stable anchors; every other module lives under `src/<category>/`.
Anchors stay at root because they are **PM2 entry points** (registered by absolute path), the
**gate harness** (run by cron + pre-commit), or the **resolver** (required everywhere) — moving
them would mean reconfiguring PM2 + cron, so they are deliberately fixed points.

```
/root/agents/
├── event-bus.js  supervisor.js  telegram-relay.js  telegram-inbound.js   # PM2 entry points
├── verify-framework.js                                                   # gate harness (cron + hook)
├── paths.js                                                              # persona resolver
│
└── src/
    ├── core/          squad-framework.js  (SQUAD_TYPES registry)
    ├── dispatch/      cloud-dispatcher · network-dispatcher · code-review-dispatcher · pentest-batch-dispatcher
    ├── pipeline/      chain-verifier · evidence-completeness · early-exit-decision · attack-graph
    ├── grading/       grader · gold-set · finding-validator
    ├── learning/      feedback-loop · memory-ranker · versioned-memory · train-from-report
    ├── routing/       model-router · target-classifier
    ├── safety/        scrub-baseline · scrub-goal-paths · offensive-vaccine · thrash-quarantine
    ├── rendering/     prompt-renderer
    ├── integrations/  anthropic-key · notifier · tracer · langfuse-tracer · quota-manager
    └── utils/         url-extractor · task-log · rotate-activity-log

tools/   test-clean-report.js · test-phase35-replay.js   (standalone, run directly)
```

**GATE-131** enforces this: root may contain ONLY the 6 anchors; every other module must live under
a populated `src/<category>/`. Adding a new module = drop it in the right category (or a new one) —
the require graph is relative, so navigation and scaling stay clean. Deeper subsystems still live
under `agents/` (the AgentRunner port `agents/runner/`, typed contracts `phase-envelope.js`, the
learning stack `episode-record.js`/`learning-loop.js`/`auto-applier.js`/`quality-tracker.js`/
`suppression-ledger.js`/`review-queue.js`/`goal-evaluator.js`, per-squad `squad.json` + policy
adapters) — `agents/` is squad-agnostic infra the gate harness loads by absolute path, kept stable.

*How the reorg was done safely (record): a deterministic migration moved 33 modules via `git mv`
and rewrote all 106 `require()` edges across the tree by resolving each to an absolute target →
new relative path; absolute requires stayed absolute (remapped); the gate harness + 4 test files'
non-`require` path references (readFileSync / require.resolve / extract-pattern patches) were fixed
by hand; then `node --check` on every file + the 130-gate suite + a dry-load of all 61 event-bus
requires before a single `pm2 reload`. Zero downtime.*

## What still lives where it did (deliberately not moved)

- **Framework helper modules** stay at `agents/` — they're squad-agnostic infra; moving them would break the 48 absolute `require()`s the gate harness needs to run. The `agents/` name is a historical misnomer (it's `lib/`), documented not renamed.
- **squad.json** (operational config, GATE-101) stays at `agents/squads/<sq>/`; **squad-policy** (GATE-81/84) at `agents/squad-policy/`. Consolidating these into `squads/<sq>/` is a tidy follow-up (Phase 3b) gated by the same resolver pattern — deferred to keep this pass's blast radius bounded.
- **Central state** (`/root/intel/`: episodes.jsonl, quality.jsonl, suppression-ledger) — already correct in the data layer.
- **`mission-control/data/squads.json`** — dashboard metadata, unrelated to this; do-not-touch.

## Backup note (state eviction)

`var/state/` is gitignored — evicted agent memory (lessons.md, grades.json, episodes) is **no longer backed up to GitHub**. Off-git floor: `scripts/backup-agent-state.sh` (rolling tarball to `/root/backups/agent-state/`, keeps last 14, cron-ready — `0 */6 * * *`). For true off-box durability, point that archive dir at rsync/S3 (your infra choice).
