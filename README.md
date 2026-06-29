<div align="center">

# ARCHON

**Autonomous AI web-application penetration tester — white-box + black-box in one engagement.**

ARCHON runs a squad of LLM-powered specialist agents against a web target, independently verifies
every finding, stops for your triage, and writes a professional report. Give it a **URL** for a
black-box assessment, or a **URL + source code** for a combined white-box + black-box engagement
whose findings merge into one de-duplicated report.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Runs on Claude](https://img.shields.io/badge/runs%20on-Claude%20(OAuth)-d97757.svg)](https://claude.ai/code)
[![Status](https://img.shields.io/badge/status-active-success.svg)](./BACKLOG.md)

</div>

> ⚠️ **Authorized testing only.** Only test systems you own or have explicit written permission to
> assess. ARCHON fails *closed* on missing scope and never fires impact-proving exploits by default,
> but **you** are responsible for staying within scope and the law. See [Safety & scope](#-safety--scope).

---

## Table of contents

- [Why ARCHON](#why-archon)
- [Features](#features)
- [How it works](#how-it-works)
- [Engagement modes](#engagement-modes)
- [The squads](#the-squads)
- [Quickstart](#quickstart)
- [Authentication — subscription, not API key](#authentication--subscription-not-api-key)
- [Usage](#usage)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Safety & scope](#-safety--scope)
- [Testing](#testing)
- [Development & contributing](#development--contributing)
- [Documentation](#documentation)
- [Roadmap & status](#roadmap--status)
- [License](#license)

---

## Why ARCHON

A pentest is mostly orchestration: map the surface, fingerprint the stack, decide what to attack,
try it, **prove it's real**, write it up. ARCHON does that as a durable multi-agent system instead
of a single prompt:

- **Specialists, not a monolith.** A lead agent plans a stack-specific attack walk; per-class
  specialists (SQLi, XSS, SSRF, IDOR, …) each go deep on their domain.
- **Evidence over claims.** Every finding is re-probed by an independent **AUDITOR**; a finding
  with no replayable evidence is demoted, not reported. A 3-judge **ARBITER** consensus gates
  High/Critical.
- **You stay in control.** The pipeline runs to *awaiting-triage* and **stops**. You confirm/reject,
  set CVSS, then explicitly generate the report. Nothing is auto-published.
- **One report, both views.** White-box (source) and black-box (live) findings are correlated and
  de-duplicated — the same bug shows up as `file:line` *and* an HTTP repro.
- **Your subscription, no API key.** Agents run the `claude` CLI over your Claude subscription
  (OAuth); there is no metered `ANTHROPIC_API_KEY`.

---

## Features

| | |
|---|---|
| 🎯 **Black-box** | Recon → stack fingerprint → ranked attack plan → parallel specialist waves (fire → observe → mutate → re-fire), WAF-adaptive. |
| 🔬 **White-box** | Source-only review: inventories → app blueprint → feature mapping → per-class assessment → AUDITOR reverse-check. |
| 🔗 **Merged engagement** | Run both; findings aggregate and a single report **de-duplicates** the same vuln seen from source and over the wire. |
| 🧪 **Independent verification** | AUDITOR re-probes findings; the **evidence contract** demotes anything without replayable proof; chain-verifier replays multi-step exploits via curl. |
| ⚖️ **Judge consensus** | 4-stage judge + 3-judge ARBITER consensus on High/Critical before publication. |
| ⏸️ **Triage-gated reporting** | Confirm / reject / set CVSS (built-in 3.1 calculator) / annotate, *then* generate the report. |
| 🔁 **Iterations** | Add focused passes to an engagement ("now test access control") without disturbing prior results. |
| 🛡️ **Safety perimeter** | Fail-closed scope gate; impact-proving exploits fire only behind a 3-gate opt-in (off by default). |
| 🖥️ **Local portal** | Zero-build single-page dashboard (binds `127.0.0.1`) for dispatch, live progress, triage, and reports. |
| 📚 **A–Z coverage** | Reports transport/config hygiene (TLS, HSTS, headers, cookie flags) alongside exploitable bugs, mapped to OWASP WSTG. |

---

## How it works

```
  OPERATOR (browser)
      │  HTTP 127.0.0.1:4000
      ▼
  DASHBOARD  scripts/dashboard.js + ui/      (read-only over the data layer;
      │  writes ONLY inbox files              dispatch/triage/report → daemon inbox)
      ▼
  var/intel/inbox/…           ← the filesystem is the IPC boundary
      │  (fs.watch + poll)
      ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │ DAEMON  event-bus.js  (codename NEXUS) — single writer of core state │
  │   dispatch queue → Phase 0.0 scope gate (fail-closed) → route        │
  │     ├─ pentest     → dispatchPentestParallel (recon → fingerprint →  │
  │     │                 plan → specialist waves → verify → judge)      │
  │     └─ code-review → code-review-dispatcher (inventories → blueprint │
  │                       → feature map → per-class assessment → AUDITOR)│
  │   each agent → runAgent(spec) → `claude` CLI (OAuth, NO API key)     │
  └───────────────────────────────────────────────────────────────────┘
      │  agents self-report findings → live-findings
      ▼
  AUDITOR verify → VALIDATED-FINDINGS → judge → JUDGED-FINDINGS
      │
      ▼  ⏸ AWAITING TRIAGE   (findings ready, no report yet)
  you triage (confirm / reject / CVSS / notes)
      │
      ▼  Generate report
  SCRIBE → ONE report  (combined runs: correlated + de-duplicated across both views)
```

The pipeline is **phased and fail-soft** — any single phase can error, log, and continue. For the
full, accurate phase-by-phase walkthrough see [`docs/ARCHON-SYSTEM-MAP.md`](./docs/ARCHON-SYSTEM-MAP.md)
and [`docs/ORCHESTRATION.md`](./docs/ORCHESTRATION.md). `CLAUDE.md` documents the pipeline table for
contributors.

---

## Engagement modes

| Mode | Input | What runs |
|---|---|---|
| **Black-box** | URL | Live pentest: recon → fingerprint → ATLAS attack plan → specialist waves firing payloads → AUDITOR → judge → SCRIBE. |
| **Static / white-box** | source dir | Source review only (no payloads): inventories → blueprint → feature mapping → per-class assessment → AUDITOR → SCRIBE. |
| **Combined (merged)** | URL + source dir | Black-box *and* white-box iterations run as one engagement; PROBER runtime-validates source findings against the live URL; `cross-view-dedup` merges both into one report. |

An **engagement** holds N independent iterations (the white-box + black-box pair, plus any focused
re-runs you add). Findings aggregate across iterations and one report is generated over all of them.

---

## The squads

Agents use operator call-signs by role. **NEXUS** is the daemon itself (`event-bus.js`), not a persona.

### `pentest` — black-box (lead: **ATLAS**)

| Agent | Domain | | Agent | Domain |
|---|---|---|---|---|
| **ATLAS** | Lead / attack planner | | **GATEWAY** | API security (incl. JWT) |
| SCOUT | Recon / surface mapping | | SENTRY | Config & transport hygiene / compliance |
| RANGER | DAST + OS command injection | | KEYRING | Session management / auth |
| TRACER | Crawling / endpoint discovery | | LEDGER | Business logic |
| VIPER | XSS | | FORGE | Supply-chain / deserialization |
| DRILL | SQL injection | | DECOY | CSRF |
| RELAY | SSRF | | SPECTRE | XXE |
| VAULT | LFI / path traversal | | WARDEN | IDOR / access control / logic |

### `code-review` — white-box (lead: **CURATOR**)

`MARSHAL` (access control) · `CIPHER` (injection/XSS) · `QUILL` · `BEACON` · `BREAKER` · `SIPHON`
— feature mappers and per-class specialists · `PROBER` — runtime validator (live-checks source
findings against a deploy URL).

### Universal agents (`_universal/agents/`)

**AUDITOR** (independent verifier) · **ARBITER** (confidence judge / publication gate) ·
**SCRIBE** (final reporter) · **COMMAND** (coordination).

---

## Quickstart

**Requires** Node ≥ 18 and the [Claude CLI](https://claude.ai/code) (ARCHON uses your Claude
subscription via OAuth — *not* a metered API key).

```bash
git clone https://github.com/ghostshift-content/ARCHON.git archon && cd archon
npm install

cp .env.local.example .env.local      # then edit the three KURU_* paths
npm run setup                         # seed the local data layer (var/intel)

npm run dashboard                     # portal → http://localhost:4000
npm start                             # (separate shell) the agent daemon
```

Open **http://localhost:4000 → New dispatch**, enter a target URL (and optionally a source
directory), and dispatch. Watch progress under **Tasks**, triage under the run's **Findings** tab,
and read the **Report** tab once generated.

> First run failing every dispatch? Check the daemon's boot preflight — a missing `claude` CLI is
> the #1 cause. The dashboard/API still serve so you can configure first.

---

## Authentication — subscription, not API key

Agents spawn the `claude` CLI, which authenticates with your **Claude subscription via OAuth**
(`~/.claude`). No `ANTHROPIC_API_KEY` is set or required — runs count against your subscription's
limits, not metered API billing. Point `KURU_CLAUDE_BIN` at your local `claude` binary
(`which claude`).

---

## Usage

1. **Authorize.** Confirm you have written permission for the target. Define in-scope /
   out-of-scope hosts (see `common/config/scope_template.yaml`).
2. **Dispatch.** Portal → *New dispatch*: target URL, optional source directory, credentials, test
   type, severity profile, triage gate.
3. **Watch.** *Tasks* shows live phase progress; the daemon recon→fingerprint→plan→attacks→verifies.
4. **Triage.** When a run reaches *awaiting-triage*, open its *Findings* tab — confirm/reject each,
   adjust CVSS and severity, add notes.
5. **Report.** Click *Generate report*; SCRIBE writes one report (combined runs are correlated and
   de-duplicated). Read it in the *Report* tab; the published file lands under `var/intel/reports/`.

The full operator workflow — authorization checklist, field-by-field dispatch guide, and
troubleshooting — is in **[OPERATOR-RUNBOOK.md](./OPERATOR-RUNBOOK.md)**.

---

## Configuration

`paths.js` reads three portable roots, auto-loaded from `.env.local` (gitignored) at require time so
the daemon, dashboard, and every spawned subprocess pick them up:

| Var | Meaning |
|---|---|
| `KURU_AGENTS_ROOT` | Code root (where `event-bus.js`, `paths.js`, `squads/` live) — usually the repo dir. |
| `KURU_INTEL_ROOT`  | Data-layer root (runtime state) — keep it under the gitignored `var/`. `npm run setup` seeds it. |
| `KURU_CLAUDE_BIN`  | Path to the `claude` CLI the agents spawn (default: resolve `claude` on `PATH`). |

Optional, **off by default**:

| Var | Effect |
|---|---|
| `PORT` | Dashboard port (default `4000`). |
| `KURU_PORTAL_SQUADS` | Comma-separated squads the portal exposes (default `pentest`). |
| `ARCHON_PORTAL_TOKEN` | Require `Authorization: Bearer <token>` on `/api/*`. Set this before exposing the portal beyond localhost. |
| `ARCHON_SCOPE_OVERRIDE=1` | Allow a dispatch with **no** scope config (Phase 0.0 is fail-*closed* — missing scope blocks the run). |
| `ARCHON_ACTIVE_POC=enabled` | Allow the gated Exploit-Prover to fire a **benign** impact-proving payload (e.g. RCE → `echo <nonce>`). Also requires `engagement_mode: active-poc` **and** a permission token in the dispatch. **Fires nothing by default.** Authorized engagements only. |
| `ARCHON_AUTONOMY=enabled` + `ARCHON_AUTONOMY_HOPS=<n>` | Surface the re-planning loop's follow-ups as an autonomy signal (hop-capped). The re-plan intel is always produced; this only flags auto-chase. |
| `ADAPTER=cli` | Use the CLI runner adapter (rollback floor) instead of the default SDK adapter. |

`var/` (all runtime state, findings, reports) is gitignored. See **[SETUP-LOCAL.md](./SETUP-LOCAL.md)**
for the portable-roots model in detail.

---

## Project structure

```
ARCHON/
├── event-bus.js              # the daemon (NEXUS): dispatch queue → phased pipeline → report
├── paths.js                  # portable-root resolver (KURU_* + .env.local autoload)
├── ownership.json            # persona → squad-home map
├── layout.config.json        # layout knobs (persona/state modes)
├── squads/                   # persona content (SOUL.md + skills) per squad
│   ├── pentest/agents/<name>/
│   └── code-review/agents/<name>/
├── _universal/agents/        # AUDITOR · ARBITER · SCRIBE · COMMAND
├── agents/                   # runtime agent logic
│   ├── runner/               # runAgent() chokepoint + sdk/cli adapters + bridge
│   ├── squads/<sq>/squad.json# operational config (enabledPhases, caps)
│   ├── squad-policy/         # per-squad scope/severity policy
│   └── *.js                  # finding schema, judge, handoff, browser verify, scope gates …
├── src/
│   ├── dispatch/             # code-review-dispatcher (white-box engine)
│   ├── pipeline/             # env-fingerprint, attack-planner, chain-verifier, evidence-contract …
│   ├── routing/              # model router + target classifier
│   ├── core/                 # squad framework + WSTG coverage map
│   ├── safety/               # scope/goal scrubbers, quarantine, offensive-vaccine
│   ├── learning/             # feedback loop, memory ranker
│   ├── grading/ · ops/ · integrations/ · rendering/ · utils/
├── common/                   # static KB: taxonomy (CWE/OWASP/WSTG), payloads, remediation, reporting
├── scripts/                  # dashboard.js (portal) + setup/metrics/handoff scripts
├── ui/                       # zero-build SPA (index.html, app.js, cvss.js)
├── tools/                    # emit-finding + maintenance utilities
├── test/                     # unit + e2e suites (node:test; run-all.js gate)
├── docs/                     # ARCHON-SYSTEM-MAP.md · ORCHESTRATION.md
└── var/                      # gitignored runtime data layer (= KURU_INTEL_ROOT)
```

---

## 🛡️ Safety & scope

The safety perimeter is **non-negotiable** and enforced in code:

- **Scope is fail-closed.** Phase 0.0 (`agents/scope-prevalidator.js`) blocks any dispatch with no
  scope config unless `ARCHON_SCOPE_OVERRIDE=1`.
- **Detecting ≠ exploiting.** Generating and firing payloads to *detect* vulns is the specialists'
  normal remit. *Demonstrating* impact (a real exploit that proves RCE) fires **only** behind a
  3-gate opt-in: `engagement_mode: active-poc` + a permission token + `ARCHON_ACTIVE_POC=enabled`.
  By default ARCHON fires nothing impact-proving.
- **Evidence contract.** A `CONFIRMED` finding needs replayable evidence (reproduction / proof /
  nonce-confirmed PoC) or it is demoted — no unverifiable claims in the report.
- **Triage-gated.** No report is auto-published; the operator confirms findings first.
- **Local-operator security.** The portal binds `127.0.0.1`; the data layer (which holds
  operator-entered test credentials) is written restrictively and `var/` is gitignored. Set
  `ARCHON_PORTAL_TOKEN` before exposing the portal beyond localhost.

---

## Testing

```bash
npm test         # unit suites (run-all.js gate). pretest auto-seeds the data layer.
npm run test:ui  # browser e2e (Playwright) — drives the portal + dispatch/triage/report flows
npm run test:bun # the few bun-only suites (node:test async semantics)
```

`npm test` is the product gate (currently green: **108 passed, 0 failed**). A handful of deeper
framework-internal suites are kept in `test/` but skipped by the gate (they target a full
multi-squad / PM2 deployment); run them individually with `node test/<file>`. New `src/pipeline/*`
modules ship with a matching `test/*.test.js`.

---

## Development & contributing

- Work from the repo root. `npm install` once; create `.env.local` from the example and
  `npm run setup` to seed `var/intel`.
- **Read [`CLAUDE.md`](./CLAUDE.md) first** — it documents the architecture, the pipeline phases,
  and the critical invariants (atomic writes, the evidence contract, never hardcode model strings,
  always resolve persona paths through `paths.js`).
- Keep changes test-backed: `npm test` must stay green. Stage specific files (never `git add -A`);
  runtime drift under `var/` is gitignored — don't commit it.
- Contributions welcome via PR. Keep new code in the style of the surrounding module; pipeline
  modules are pure + tested.

---

## Documentation

ARCHON keeps its planning and architecture in-repo so the project tracks like a real OSS effort:

| Doc | What it covers |
|---|---|
| **[CLAUDE.md](./CLAUDE.md)** | Architecture, file map, pipeline phases, and the invariants contributors must uphold. |
| **[docs/ARCHON-SYSTEM-MAP.md](./docs/ARCHON-SYSTEM-MAP.md)** | Top-to-bottom system map: every subsystem, end-to-end lifecycles, data layout, and the prioritized improvement surface. |
| **[docs/ORCHESTRATION.md](./docs/ORCHESTRATION.md)** | How a dispatch flows, which model each role uses, and the operational-health invariants. |
| **[OPERATOR-RUNBOOK.md](./OPERATOR-RUNBOOK.md)** | Authorize → dispatch → triage → report, field by field, with troubleshooting. |
| **[SETUP-LOCAL.md](./SETUP-LOCAL.md)** | Portable roots, `.env.local`, and the local-dev data layer. |
| **[BACKLOG.md](./BACKLOG.md)** | Open bugs and improvements: symptom → root cause (file) → fix. |

---

## Roadmap & status

Active development. The current backlog and prioritized improvement surface live in
**[BACKLOG.md](./BACKLOG.md)** and **[§8 of the system map](./docs/ARCHON-SYSTEM-MAP.md)** — work
proceeds in tiers (show-stoppers → correctness/invariants → dead-code sweep → docs → refactors).
Open an issue or PR to propose or pick up an item.

---

## License

[MIT](./LICENSE).

---

<div align="center">
<sub>

**ARCHON** — Autonomous Research & Code Hunting for Offensive Networks. Built on
[Claude](https://claude.ai/code). For authorized security testing only.

</sub>
</div>
