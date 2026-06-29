# ARCHON

**Autonomous AI web-application penetration testing — white-box + black-box in one engagement.**

ARCHON runs a squad of LLM-powered specialist agents against a web target, validates every
finding independently, stops for your triage, and writes a professional report. Give it a **URL**
for a black-box assessment, or a **URL + source code** for a combined white-box + black-box
engagement whose findings merge into one de-duplicated report.

> ⚠️ **Authorized testing only.** Only test systems you own or have explicit written permission
> to assess. You are responsible for staying within scope and the law.

---

## What it does

- **Black-box** (URL only): recon → specialist exploitation (XSS, SQLi, SSRF, IDOR, SSTI, XXE,
  CSRF, LFI, API/JWT, business logic, …) → independent verification → judge → report.
- **White-box + black-box** (URL + source dir): a source code review runs **alongside** the live
  pentest as one *engagement*; their findings aggregate and a single report **correlates and
  de-duplicates** the same vulnerability seen from both sides (source `file:line` + live HTTP repro).
- **A→Z coverage**: reports everything in scope including transport/config hygiene (TLS versions,
  ciphers, HSTS, security headers, cookie flags), not just exploitable bugs.
- **Triage-gated reporting**: the pipeline produces findings then **stops**. You confirm/reject,
  adjust CVSS (built-in 3.1 calculator) and severity, add notes — then click **Generate report**.
- **Iterations**: run more focused tests on the same engagement ("now test access control") without
  affecting prior results; findings append and filter per iteration.

### How testing flows

```
New dispatch (pentest)
  URL                     → black-box pipeline (ATLAS's squad)
  + source dir (optional) → white-box pipeline runs in parallel, bridged to the URL
        │
        ▼
  recon → specialists → AUDITOR verify → ARBITER judge
        │
        ▼  ⏸ AWAITING TRIAGE  (findings ready, no report yet)
  you triage in the Findings tab (confirm / reject / CVSS / notes)
        │
        ▼  Generate report
  SCRIBE writes ONE report — for combined runs, correlated + de-duplicated across both views
```

---

## Quickstart

Requires **Node ≥ 18** and the **Claude CLI** (ARCHON uses your Claude subscription via OAuth — see
below — not a metered API key).

```bash
git clone <your-fork-url> archon && cd archon
npm install
cp .env.local.example .env.local      # edit the three KURU_* paths
npm run setup                         # seed the local data layer (var/intel)
npm run dashboard                     # portal → http://localhost:4000
npm start                             # (separate shell) the agent daemon
```

Open **http://localhost:4000 → New dispatch**, enter a target URL (and optionally a source
directory), and dispatch. Watch progress under **Tasks**; triage under the run's **Findings** tab;
read the **Report** tab when generated.

For the full operator workflow — authorization checklist, field-by-field dispatch guide, and
troubleshooting — see **[OPERATOR-RUNBOOK.md](./OPERATOR-RUNBOOK.md)**.

### Authentication — subscription, not API key

Agents run the `claude` CLI, which authenticates with your **Claude subscription via OAuth**
(`~/.claude`). No `ANTHROPIC_API_KEY` is set or required; runs count against your subscription's
limits, not metered API billing. Point `KURU_CLAUDE_BIN` at your local `claude` binary.

---

## Configuration

`paths.js` reads three env vars (auto-loaded from `.env.local`):

| Var | Meaning |
|---|---|
| `KURU_AGENTS_ROOT` | code root (where `event-bus.js`, `squads/` live) — usually the repo dir |
| `KURU_INTEL_ROOT`  | data-layer root (runtime state); keep under the gitignored `var/` |
| `KURU_CLAUDE_BIN`  | path to the `claude` CLI the agents spawn (default: resolve `claude` on `PATH`) |

`var/` (all runtime state, reports, findings) is gitignored.

Optional, off by default:

| Var | Effect |
|---|---|
| `ARCHON_PORTAL_TOKEN` | require `Authorization: Bearer <token>` on `/api/*` — set it before exposing the portal beyond localhost |
| `ARCHON_SCOPE_OVERRIDE=1` | allow a dispatch with **no** scope config (Phase 0.0 fails *closed* by default — a missing scope blocks the run) |
| `ARCHON_CALENDAR=1` | enable the calendar scheduler (a mission-control feature; off in the OSS build) |
| `KURU_MISSION_CONTROL_DATA` | path to an optional mission-control data dir (`agents.json`/`squads.json`/`calendar.json`); absent is fine — the pipeline has built-in role fallbacks |
| `ARCHON_ACTIVE_POC=enabled` | allow the gated Exploit-Prover to **fire a benign payload** that *proves* impact (RCE → `echo <nonce>`). Requires `engagement_mode: active-poc` + a valid permission token in the dispatch. **Off by default — fires nothing.** Authorized engagements only. |
| `ARCHON_AUTONOMY=enabled` + `ARCHON_AUTONOMY_HOPS=<n>` | surface the re-planning loop's high-value follow-ups as an autonomy signal (hop-capped). The re-plan *intel* is always produced; this just flags auto-chase. |

### Prerequisites & failure modes

- **Claude CLI required.** Agents spawn `claude` (subscription/OAuth, `~/.claude`). The daemon
  runs a boot preflight and warns clearly if it's missing — without it every dispatch fails. The
  dashboard/API still serve so you can configure first.
- **mission-control is optional.** The OSS build ships without it; the roster falls back to built-in
  defaults, so an absent `KURU_MISSION_CONTROL_DATA` dir is expected.
- **Local-operator security.** The portal binds `127.0.0.1` only. The data layer holds operator-entered
  test credentials (engagement sidecars + briefs are written `0600`; `npm run setup` chmods the root
  `0700`). Keep `var/` private; it is gitignored by default.

---

## Architecture

- **`event-bus.js`** — the daemon: a phased, fail-soft pipeline (recon → specialists → verify →
  judge → report) supervising the squad. Reads tasks from an inbox; single writer of core state.
- **`scripts/dashboard.js`** — the ARCHON portal: a read-only HTTP API over the data layer +
  dispatch/triage/report controls (writes flow to the daemon's inbox, never to core state directly).
- **`ui/`** — the single-page portal (no build step): dispatch, tasks, per-run findings/triage,
  CVSS calculator, reports.
- **`squads/pentest/`** — the black-box squad (ATLAS + specialists). **`squads/code-review/`** —
  the white-box engine. **`_universal/agents/`** — AUDITOR (verifier), ARBITER (judge), SCRIBE (reporter).
- **Engagement model** — one dispatch holds N independent iterations (incl. the white-box + black-box
  pair); findings aggregate and one report is generated across all of them.

---

## Tests

```bash
npm test         # unit suites (CVSS, portal API, scope/profile, engagement, code-review dispatch)
npm run test:ui  # browser e2e (Playwright) — drives the portal + dispatch/triage/report flows
```

`npm test` is the product gate. Deeper framework-internal suites are kept in `test/` but skipped by
the gate (they target a full multi-squad / PM2 deployment); run them individually with `node test/<file>`.

---

## License

MIT — see [LICENSE](./LICENSE).

---

*Agents use operator call-signs by role — ATLAS (lead), SCOUT (recon), DRILL (SQLi), AUDITOR
(verifier), ARBITER (judge), SCRIBE (reporter), … ARCHON = Autonomous Research & Code Hunting for
Offensive Networks.*
