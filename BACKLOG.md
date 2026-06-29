# ARCHON — Bug & Improvement Backlog

Open issues observed during live HTB testing (2026-06-29 session). Ordered by impact.
Each item: symptom → root cause (with file) → proposed fix.

---

## P1 — Findings invisible until Phase 3 (agents don't use `emit-finding`)

- **Symptom:** Agents confirm real CRITICALs during recon (e.g. MongoDB `$facet`/`$lookup`
  injection, dumped 15 invite tokens) but the Findings tab stays empty — `live-findings-<task>.jsonl`
  is never written. Findings only appear after Phase 3 AUDITOR parses the activity log.
- **Root cause:** Specialists/recon agents log findings as free-text to `ACTIVITY-LOG.jsonl`
  (their SKILL.md habit) instead of calling `tools/emit-finding.js`. The clean-emission helper +
  the MANDATORY prompt block in `buildPentestSpecialistPrompt` (event-bus.js ~3700) are ignored —
  the agents follow their skill's "echo activity" pattern. 0 `emit-finding` calls in agent streams.
- **Impact:** No live amber→green finding lifecycle; the never-corrupt emission we built is unused;
  findings depend on AUDITOR re-parsing free-text (the fragility we tried to kill at source).
- **Proposed fix:** Make emission mandatory at the skill level — update the specialist + recon
  SKILL.md files (`squads/pentest/agents/*/skills/**/SKILL.md`) so EVERY confirmed/suspected finding
  is recorded via `emit-finding.js` (not echo), with the activity-log entry as a secondary human
  note only. Reinforce in the prompt that the finding is NOT counted unless emitted via the tool.

## P1 — Recon agents re-run a redundant, very slow full nmap

- **Symptom:** Phase 1 recon drags 25–35 min. RANGER runs `nmap -sV -sC -p 1-65535 -T2 --max-rate 50`
  (all 65535 ports at ~50 pkt/s = ~25+ min) on top of the Phase 0.4 heart-truth scan that already
  found the open ports in ~60s.
- **Root cause:** Recon agents' SKILL.md instructs them to run their own nmap; they don't trust/use
  the `nmap-<task>.json` heart-truth already in their prompt. No guidance against `-p-` re-scans or
  slow timing.
- **Impact:** ~25 min wasted per run; the single biggest cause of "nothing's happening" in the UI.
- **Proposed fix:** In `buildPentestSpecialistPrompt`'s nmap block (event-bus.js ~3700) + RANGER/SCOUT
  SKILL.md: state the full port/service scan is DONE (cite the artifact), and recon must NOT re-run a
  `-p-` scan — only targeted follow-ups (`-sV`/`-sC` on the known open ports) if needed.

## P2 — Recon agents over-exploit instead of handing off to Phase 2

- **Symptom:** SCOUT does deep MongoDB exploitation (collection brute-force, data dump) *during
  Phase 1 recon*, so the phase doesn't settle and Phase 2 specialists never get to run.
- **Root cause:** No scope/time boundary on recon — recon agents are allowed to fully exploit, which
  overlaps the Phase 2 specialists' job and stalls the pipeline.
- **Impact:** Pipeline stuck in recon; Phase 2/3 (validation, report) delayed or never reached within
  the 45-min hard cap.
- **Proposed fix:** Give recon a clear boundary — surface attack surface + flag promising vulns, but
  hand deep exploitation to Phase 2 specialists. Optionally a soft time budget on recon agents.

## P2 — Pre-flight reachability false-positive (`000000`) + wrong-port check

- **Symptom:** Daemon logged `✅ Pre-flight: http://10.129.41.232 reachable (HTTP 000000)` for an
  unreachable host (000 = no connection).
- **Root cause:** `curl ... -w "%{http_code}" ... || echo "000"` — on failure curl prints `000` AND
  the `|| echo "000"` appends another → `"000000"`, which `!== '000'`, so the abort check passes
  (event-bus.js ~4540). Also: pre-flight hits the bare URL (port 80), but the app is often on another
  port (e.g. 3000) — a healthy box with no port-80 web looks unreachable / vice-versa.
- **Impact:** Unreachable targets aren't caught (waste a full run); the 000 abort guard is dead.
- **Proposed fix:** Capture curl's exit code explicitly (don't string-concat), and treat the box as
  reachable if it PINGS or any nmap port is open — not just HTTP on port 80.

## P3 — crawl4ai browser can't reach a vhost without `/etc/hosts`

- **Symptom:** For a vhost box (`aegis.korvia.htb`), the browser crawl can't resolve the name; CLI
  tools work via `--resolve` but the browser (crawl4ai/CDP) can't.
- **Root cause:** Browsers don't support `--resolve`; the vhost isn't in DNS/`/etc/hosts`. Daemon has
  no sudo to add the hosts entry (event-bus.js _runtracerAgentInner ~2390). Currently only a one-time
  sudo line is surfaced.
- **Impact:** Deep browser crawl skipped on vhost boxes (CLI crawl + specialists still cover surface).
- **Proposed fix:** Option A: if the daemon ever gets a writable hosts mechanism, auto-add same-IP
  vhosts. Option B: run a tiny local resolver (dnsmasq/hostsfile) the browser uses. Option C: accept
  the gap + keep the surfaced sudo line. (Low priority — CLI path covers it.)

## P3 — Phase-boundary cancel aborts only wired for pentest

- **Symptom:** The `spawnAgent` cancel guard is universal (all squads), but the explicit
  phase-boundary aborts were added only in `dispatchPentestParallel`.
- **Root cause:** cloud/network/code-review dispatchers don't have the pre-phase `_isTaskCancelled`
  checks (event-bus.js — their dispatch functions).
- **Impact:** Low — the `spawnAgent` chokepoint already makes a cancelled run inert everywhere; this
  is belt-and-suspenders for faster abort + skipping daemon phases.
- **Proposed fix:** Add the same `if (_isTaskCancelled(taskId)) { killTaskChildren; return ... }`
  checks at the major phase boundaries in the other squad dispatchers.

## P3 — Ops: system clock / NTP not synced

- **Symptom:** After reboot the clock was ~22h off; tasks got future timestamps and new dispatches
  sorted below them on the board (mitigated by the active-first sort).
- **Root cause:** `timedatectl: NTP service: inactive` — not a code bug, an environment issue.
- **Proposed fix:** Document `sudo timedatectl set-ntp true` in setup/README so a fresh install/reboot
  keeps the clock synced. (Board sort fix already makes the UI resilient to skew.)

---

## Fixed this session (for reference — do NOT re-open)

- ✅ Cancel didn't kill agents (cooperative cancellation: spawnAgent guard + phase aborts + status)
- ✅ Watchdog false-killed recon agents (tool activity resets the stall timer)
- ✅ Findings corrupted/dropped in JSONL (tolerant `loose-jsonl` reader + `emit-finding` writer)
- ✅ Board buried new dispatches (active-first sort, clock-skew resilient)
- ✅ crawl4ai failed even when installed (self-spawn when no CDP Chrome)
- ✅ Generate-report produced 0-finding reports (ensureValidatedFindings + early enrich)
- ✅ normalizeFinding could drop a finding with no id (always assigns an id)
