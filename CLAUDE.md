# ARCHON — autonomous AI web-application pentester

Durable multi-agent orchestrator for web security testing. **Read this BEFORE modifying `event-bus.js`
or anything under `agents/` / `src/`.**

> **Layout:** personas live at `squads/<sq>/agents/<name>/` (universals at `_universal/agents/<name>/`),
> runtime state under `var/state/agents/<name>/`. **Never hardcode a persona path** — use `paths.js`
> (`agentPaths.soulPath(name)`, `skillsDir`, `personaState`, `lessonsPath`…). Layout map: `STRUCTURE.md`.

## What this is

ARCHON is a Node.js daemon that runs LLM-powered specialist agents against a web target — **black-box**
(live URL), **static analysis** (source only), or **white-box** (both, merged into one de-duplicated
report). It runs on the **Claude subscription via OAuth — no API key** (`KURU_CLAUDE_BIN` → the `claude`
CLI). Two squads:

| Squad | Leader | Specialists | Domain |
|---|---|---|---|
| pentest | ATLAS | SCOUT, RANGER, TRACER (recon) · VIPER, DRILL, RELAY, VAULT, WARDEN, GATEWAY, SENTRY, KEYRING, LEDGER, FORGE, DECOY, SPECTRE (specialists) | Black-box web security |
| code-review | CURATOR | MARSHAL, CIPHER, QUILL, BEACON, BREAKER, SIPHON · PROBER (runtime validator) | White-box source review |

Universal agents (`_universal/agents/`): **AUDITOR** (independent verifier), **ARBITER** (confidence
judge), **SCRIBE** (final reporter), **COMMAND** (coordination). **NEXUS** is the daemon itself
(`event-bus.js`), not a persona.

## Top-level files

| File | Role |
|---|---|
| `event-bus.js` | The daemon (~10K lines). Dispatch queue → phased pipeline → report. **Be careful editing.** |
| `paths.js` | Persona/squad path resolver. Reads `layout.config.json` + `ownership.json` (mtime-cached, fail-soft). Portable roots via `KURU_AGENTS_ROOT` / `KURU_INTEL_ROOT` / `KURU_CLAUDE_BIN` + `.env.local` autoload. |
| `ownership.json` / `layout.config.json` | persona→squad-home map + layout knobs. |
| `scripts/dashboard.js` | The portal — HTTP API + SPA over the data layer (binds `127.0.0.1`). Dispatch/triage/report controls write to the daemon inbox. |
| `agents/runner/` | `agent-runner.js` = chokepoint `runAgent(spec)` → `{text,usage,model,raw}`; **default adapter `sdk`** (subscription OAuth), `ADAPTER=cli` rollback; `adapters/common.js` = env allowlist; `run-agent-bridge.js` = legacy `{code,output,cost,model}` shape for the spawnAgent retry path. |
| `src/dispatch/code-review-dispatcher.js` | White-box engine: inventories → App Blueprint → feature mapping → per-class assessment → AUDITOR → SCRIBE. |
| `src/core/squad-framework.js` | `SQUAD_TYPES` registry (pentest + code-review). |
| `src/routing/model-router.js` / `model-config.js` | Family→model mapping + per-agent selection. Never hardcode model strings — use `modelRouter.resolve(agentName)`. |
| `src/pipeline/` | Autonomy + methodology modules: `env-fingerprint`, `attack-planner`, `exploit-prover`, `outcome-classifier`, `cross-view-dedup`, `pentest-phases`, `chain-verifier`, `attack-graph`. |
| `src/core/coverage-map.js` + `common/taxonomy/owasp_wstg.yaml` | WSTG A-Z coverage map → specialist charters. |
| `src/pipeline/evidence-contract.js` | "No replayable evidence → not CONFIRMED" (enforced at `agents/auditor-validated-builder.js`). |
| `agents/scope-prevalidator.js` | Phase 0.0 scope gate — **fail-closed** (missing scope blocks; `ARCHON_SCOPE_OVERRIDE=1` to allow). |
| `agents/active-poc-policy.js` + `agents/active-poc-runner.js` | 3-gate perimeter for firing real payloads (engagement_mode + permission token + `ARCHON_ACTIVE_POC`). |
| `agents/finding-schema.js` | Canonical finding shape (`impact`, `proof_of_execution`, `reproduction_*`). |
| `common/` | `taxonomy/` (CWE + OWASP Top-10/API/LLM/Mobile + WSTG), `payloads/` (technique KB), `reporting/`, `remediation/`. Per-vendor WAF bypasses: `agents/refs/waf-bypass.md`. |

## Pipeline (pentest, `dispatchPentestParallel`)

All phases are **fail-soft** — an error logs and continues. Optional phases are config-gated via
`agents/squads/pentest/squad.json` `enabledPhases` (see `src/pipeline/pentest-phases.js`).

| Phase | Purpose |
|---|---|
| 0.0 | Scope pre-validate (fail-closed) |
| 0 / 0.7 | WAF detect + complexity scoring |
| 1 / 1.5 / 1.6 / 1.8 | Recon (SCOUT/RANGER/TRACER), spot-check, JS-bundle scan, EndpointModel |
| **0.6** | **Env fingerprint** — identify the exact product/stack + WAF vendor (`env-fingerprint.js`) |
| **1.9** | **Strategist** — ATLAS ranks a stack-specific attack plan, walking the WSTG map (`attack-planner.js`) |
| 2 | Specialist waves — generate **stack-specific** payloads, adapt to the WAF (fire→observe→mutate→refire) |
| 2.5 / 2.9 | Fast-verify + contradiction detector |
| 3 / 3.05 | AUDITOR verify → VALIDATED-FINDINGS (evidence contract enforced here) |
| 3.055–3.08 | Challenger, scope/prod annotation, evidence capture, severity filter, active-poc |
| **3.085** | **Exploit-Prover** — gated benign payload that *proves* impact → `proof_of_execution` |
| **3.087** | **Re-plan** — ATLAS lists follow-ups + chains left to chase |
| 3.5 / 3.6 / 3.8 | Chain construct + verify (curl) + browser verify |
| 3.9 | ARBITER judge (3-judge consensus on High/Critical) |
| 4 | SCRIBE final report (impact + proof + WSTG coverage + correlation) |

## Safety perimeter

Generating/firing payloads to **detect** vulns is the specialists' normal remit. **Demonstrating impact**
(a real exploit that proves RCE) fires ONLY behind the active-poc 3 gates — default fires nothing. Scope
is **fail-closed**. Both are non-negotiable for an OSS exploit tool.

## Critical patterns

- **Atomic writes**: `writeAtomic(file, data)` + `withFileLock(file, fn)` (`acquireLock`, stale-steal 10s)
  for `tasks.json` / `dispatch-queue.json` / `ACTIVITY-LOG.jsonl`. Never bare `fs.writeFileSync` on these.
- **`logActivity('AGENT', '…', { type, squad, taskId, projectId })`** — agent UPPERCASE, type for filtering.
- **Never hardcode model strings** — `modelRouter.resolve(agentName)`.
- **Evidence contract** — a CONFIRMED finding needs replayable evidence (reproduction / proof /
  nonce-confirmed PoC) or it's demoted to NEEDS-LIVE. Enforced in `auditor-validated-builder.js`.
- **Dossier selection** — published report = the canonical author's file (security squads → SCRIBE).
  Use `selectBestDossierFile(...)` from `agents/dossier-selector.js`; never re-implement inline.
- **Pipeline modules are pure + tested** — new `src/pipeline/*` modules ship with a `test/*.test.js`.

## Working directory rules

- Work from the repo root. Direct-to-`main` is approved.
- Tests: `npm test` (→ `node test/run-all.js`). UI e2e: `npm run test:ui`.
- Stage specific files (never `git add -A`). Runtime drift under `var/` is gitignored — don't commit it.
- Co-Authored-By footer: `Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## See also
- `README.md` — quickstart + architecture · `OPERATOR-RUNBOOK.md` — authorize → dispatch → read output
- `SETUP-LOCAL.md` — env + portable roots · `STRUCTURE.md` — folder map
