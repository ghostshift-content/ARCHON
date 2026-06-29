# ARCHON Operator Runbook — Set Up & Run a Pentest

A clean, repeatable sequence for dispatching an engagement on ARCHON. Written
against the actual dashboard (the three-mode "New dispatch" form) and the
ATLAS → recon → specialists → AUDITOR → ARBITER → SCRIBE pipeline.

> Install details live in [`SETUP-LOCAL.md`](./SETUP-LOCAL.md); this is the
> operator workflow. Everything here is verifiable from `package.json`,
> `.env.local.example`, and the dashboard.

---

## 0. Authorization — do this before every engagement

ARCHON hard-blocks out-of-scope hosts at Phase 0, but that is a *technical* guard,
not legal cover. The operator owns authorization.

- [ ] **Written authorization / Rules of Engagement** for every in-scope host —
      signed, dated, naming the targets and the testing window.
- [ ] **Scope locked:** exact in-scope hosts, and the adjacent hosts you must
      *never* touch (shared infra, third-party SaaS, prod payment, etc.).
- [ ] **Test accounts provisioned** by the target owner — ideally ≥2 roles so
      cross-role authorization (IDOR / privilege-escalation) can actually be tested.
- [ ] **Fill `common/config/authorization_checklist.md`** and keep it with the
      engagement record.
- [ ] **Emergency stop / contact** agreed — who to call if something goes wrong on
      the target side, and how you kill a run (stop the daemon).

> Rule of thumb: if you can't point to the document that authorizes testing this
> exact host, don't put it in the **In scope** box.

---

## 1. One-time local setup

Done once per machine (or after a fresh clone). Full detail in `SETUP-LOCAL.md`.

```bash
# 1. Node 18+ (package.json engines: node >=18)
node --version

# 2. Install deps
npm install

# 3. Create your local env file from the example
cp .env.local.example .env.local
#    then edit .env.local and set the three KURU_* values:
#    - KURU_AGENTS_ROOT  — code root; the repo dir (paths.js resolves from here)
#    - KURU_INTEL_ROOT   — data/state root; keep it at <repo>/var/intel (gitignored)
#    - KURU_CLAUDE_BIN   — path to your `claude` CLI  (find it with: which claude)
#    paths.js autoloads .env.local for the daemon AND every spawned agent.

# 4. Run the setup script
npm run setup            # → node scripts/setup-local.js  (seeds var/intel)

# 5. Sanity-check the framework before trusting it
npm test                 # → node test/run-all.js  (unit + gate suite)
```

**Authentication: no API key.** ARCHON runs on your **Claude subscription via
OAuth** (`~/.claude`) — there is **no `ANTHROPIC_API_KEY`** to set. Just make sure
the `claude` CLI is installed and logged in (run `claude` once to authenticate),
and point `KURU_CLAUDE_BIN` at it. The daemon prints a preflight line at boot
telling you whether it found the CLI.

If `npm test` surfaces failures in the **gate** tests (`test/gate-*.test.js` —
scope, severity-profile, chain integrity, canonical-URL, …), fix those first: those
gates are what guarantee scope enforcement and report integrity. A pentest run on a
framework with red gates is not trustworthy output.

---

## 2. Start the system — every session

Two processes. The **daemon** does the work; the **dashboard** is just the
control panel.

```bash
# Terminal 1 — THE daemon (event-bus). Picks up queued dispatches in seconds.
npm start                # → node event-bus.js

# Terminal 2 — the dashboard UI you dispatch from
npm run dashboard        # → node scripts/dashboard.js   (http://localhost:4000)
```

**The single most common failure:** dispatching from the UI while the daemon
(`npm start`) isn't running. The task queues and nothing happens — no recon, no
specialists. If a dispatch seems dead, check Terminal 1 first.

Confirm it's live: open the dashboard → **Tasks** / **Activity** should show the
daemon heartbeat and pick up new dispatches within seconds.

---

## 3. Choose the test type

| You have… | Use | Form needs |
|-----------|-----|-----------|
| Only a live URL, no source | **Black-box** | URL + scope + test accounts + vuln focus |
| Only source code, no live testing | **Static Analysis** | Source dir (+ optional Deployed URL to runtime-validate findings) |
| Both source *and* a live target | **White-box** | URL + source dir + scope + accounts + focus → one merged, de-duplicated report |

White-box is the most thorough — ARCHON reviews the source *and* validates findings
against the running app, then merges both views into a single report with duplicates
removed. Use it whenever you have both.

---

## 4. Fill the dispatch form (field by field)

**Squad** — `pentest — leader ATLAS`. ATLAS orchestrates recon → specialists →
verification → report.

**Title** — make it identifying: `Pentest staging.acme.com — 2026-06 RoE#1442`.
This is how you'll find the run in Tasks/Reports later. Don't leave it generic.

**Web application URL** *(black-box & white-box, required)* — the primary live
target. **Its host is auto-added to In scope**, so you don't repeat it below.

**Source code directory** *(static & white-box, required)* — absolute path to the
source tree (`/home/you/targets/acme-src`). ARCHON maps the codebase automatically
(starting with an App Blueprint: infra, auth model, shared components).

**Deployed URL** *(static analysis, optional)* — if the source you're reviewing is
also running somewhere, put that URL here so agents runtime-validate source findings
against the live app (cuts false positives).

**Coverage** *(black & white-box)* —
- *Full end-to-end* = test the whole app. Default for a real engagement.
- *Feature-driven* = focus only on the features you name. Use when scope is a
  specific flow (e.g. just checkout) or you're time-boxed.

**In scope / Out of scope** — one host per line. Wildcards work
(`*.api.example.com`). **Be explicit in Out of scope** about sensitive neighbors
(`status.example.com`, `blog.example.com`, anything shared) — Phase 0 rejects these
hard, and writing them down is your safety net against accidental reach.

**Test accounts** — username · password · role. **Add one row per role you were
given.** Agents authenticate as each and test cross-role authorization — this is
where IDOR and privilege-escalation findings come from. One account = no cross-role
testing, so add at least two (e.g. `normal` + `admin`, or two `normal` users) if the
target owner provided them.

**Scan strategy → Skip initial recon** — leave **unchecked** for a normal run. Check
it only when you already know the attack surface and want agents to go straight to
authenticated functionality testing (saves time, but you lose surface/WAF discovery).

**Vulnerability focus** — the chips: **Access control / IDOR, Auth, SQLi,
Command injection, XSS, SSRF, SSTI, XXE, CSRF, LFI, API, Business logic**, plus a
**Custom / abuse-driven** chip that opens a free-text box for anything not covered
(e.g. "cache poisoning").
- **Select none = full A→Z deep dive** (every class). Default for thoroughness.
- **Select some = focused, faster scan** on just those classes. Use when you have a
  specific hypothesis or a tight window.

**Priority** — Low / Normal / High. Affects queue ordering when multiple tasks are
running.

**Model override** — leave on **auto (router decides)** unless you have a specific
reason; the router picks the model per phase/role.

Then **Dispatch to squad**.

---

## 5. What happens after you dispatch

On dispatch the daemon writes the engagement artifacts and runs the pipeline:

1. **`scope-<taskId>.json`** — the locked scope config.
2. **Engagement brief** (`pentest-brief-<taskId>.md`) — target, scope, focus, and
   the test-account table.
3. **Phase 0 — scope hard-block.** Out-of-scope hosts are rejected here (fail-closed:
   no scope config = blocked). Nothing downstream can touch them.
4. **Recon** (SCOUT, RANGER) — auth surface, WAF, attack surface mapping.
   *(Skipped if you checked Skip-recon.)*
5. **Specialists** — one per vuln class, authenticating with your test accounts,
   testing each role for cross-role authz.
6. **AUDITOR** independently verifies findings → **ARBITER** judges/calibrates
   confidence → **SCRIBE** writes the final report. If the judge can't run, the
   report is stamped **VERIFICATION INCOMPLETE** rather than shipping un-vetted.

Monitor from the dashboard: **Tasks** (status/progress), **Activity** (live agent
actions), **Reports** (output when SCRIBE finishes). Reports and run state are
written under your **`KURU_INTEL_ROOT`** (`var/intel` locally) — final reports land
in `var/intel/reports/<taskId>.md`.

---

## 6. Reading the output

The SCRIBE report is the deliverable: **deduplicated** findings (no double-counting
across source vs live in white-box — a deterministic correlation pass writes
`correlation-<taskId>.json` and SCRIBE merges only within those groupings), each
**verified by AUDITOR** and **confidence-judged by ARBITER**. For white-box runs,
source and live findings for the same issue are merged into one entry. Triage from
there.

---

## 6b. Autonomous mode (AI-driven)

ARCHON reasons about the target and adapts payloads to it — you don't configure this,
it happens inside the run:

1. **Fingerprint (Phase 0.6)** — identifies the *exact* stack (e.g. "Adobe AEM 6.5",
   WAF vendor) → `env-fingerprint-<taskId>.json`.
2. **Strategist (Phase 1.9)** — ATLAS ranks *what to attack first*, stack-specific →
   `attack-plan-<taskId>.json`.
3. **Adaptive exploitation (Phase 2)** — specialists generate payloads **specific to the
   product** (AEM → AEM payloads, not generic) and, when a WAF is named, fire → read the
   block → **mutate with vendor-specific bypasses** → refire. Every attempt is logged.
4. **Re-plan (Phase 3.087)** — after the round, ATLAS lists the follow-ups + **attack
   chains** still worth chasing → "Recommended Next Round" in the report.

### Proving impact with a live PoC (gated — authorized engagements only)

By default ARCHON **describes** impact but never fires an exploit to demonstrate it. To
have the **Exploit-Prover** fire a *benign* payload that proves impact (RCE → `echo
<nonce>`, confirmed only if the nonce comes back), an engagement must clear **all three
gates**:

- `ARCHON_ACTIVE_POC=enabled` in the daemon env, **and**
- the dispatch carries `engagement_mode: "active-poc"`, **and**
- a valid `active_poc_permission` token (issuer, expiry, `scope_domains`, capabilities).

Miss any one → nothing fires (logged as "no fire"). Only enable this against targets you
are explicitly authorized to actively exploit. `ARCHON_AUTONOMY=enabled` (hop-capped via
`ARCHON_AUTONOMY_HOPS`) surfaces the re-plan's high-value follow-ups as an auto-chase
signal; the re-plan intel itself is always produced.

---

## 7. Troubleshooting setup

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Dispatch queues but nothing runs | daemon not running | Start `npm start` (Terminal 1) |
| Host rejected at Phase 0 | host not in scope / out-of-scope match | Add to **In scope**; check wildcard spelling |
| Boot says "claude CLI not found" / agents fail | `claude` not installed or not logged in | Install the Claude CLI, run `claude` to log in (OAuth), or set `KURU_CLAUDE_BIN` to its path |
| No IDOR/authz findings | only one test account given | Add a second role under **Test accounts** |
| Findings look thin | recon skipped or wrong scope | Uncheck Skip-recon; verify URL + scope |
| Report flagged "VERIFICATION INCOMPLETE" | judge (ARBITER) couldn't run | Re-run; High/Critical findings are un-vetted until it does |
| Gate tests red | framework integrity issue | Fix gates before trusting any report (§1) |
| Can't find a past run | generic Title | Use identifying Titles (§4) |

---

## Quick-reference card (pin this)

```
SETUP (once):   npm install → cp .env.local.example .env.local (set 3 KURU_* paths)
                → npm run setup → npm test  (gates must be green)
                NO API KEY — log in once with `claude` (subscription OAuth)

EVERY SESSION:  Terminal 1: npm start         (daemon — does the work)
                Terminal 2: npm run dashboard (UI — http://localhost:4000)

AUTHORIZE:      RoE signed · scope locked · test accounts ≥2 roles
                · authorization_checklist.md filled

DISPATCH:       pick test type (black / static / white)
                → URL and/or source dir → scope in/out → test accounts
                → coverage → vuln focus (none = full) → Dispatch

PIPELINE:       scope-<taskId>.json + brief → Phase 0 block → Recon
                → Specialists → AUDITOR → ARBITER → SCRIBE report

WATCH:          Tasks · Activity · Reports   (output under var/intel/reports/)

GOLDEN RULE:    if no document authorizes testing this exact host,
                it does not go in the In-scope box.
```
