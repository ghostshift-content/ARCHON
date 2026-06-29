# ARCHON — Bug & Improvement Backlog

Open issues observed during live HTB testing (2026-06-29). Most P1/P2 items fixed; remaining
are lower-priority features/ops. Each item: symptom → root cause (file) → fix.

---

## OPEN

### P3 — Authenticated crawl: TRACER stops at `/login`
- **Symptom:** `⚠️ TRACER low-coverage: only 1 URL discovered`. The app redirects everything to
  `/login`; the unauthenticated crawl can't get past the auth wall, so endpoint coverage is ~0.
- **Root cause:** The crawl (crawl4ai/katana) runs unauthenticated; test-account credentials from
  the dispatch (`meta.credentials`) aren't wired into the crawl (event-bus.js `_runtracerAgentInner`).
- **Fix:** Pass the test-account login (cookie/bearer or a login step) into crawl4ai so it crawls the
  authenticated app. Feature-sized (login automation per app), so deferred.

### P3 — crawl4ai browser can't reach a vhost without `/etc/hosts`
- **Symptom:** For a vhost box (`aegis.korvia.htb`), the browser can't resolve the name; CLI tools use
  `--resolve`, but the browser (crawl4ai/CDP) can't.
- **Root cause:** Browsers don't support `--resolve`; the vhost isn't in DNS/`/etc/hosts`; daemon has
  no sudo (event-bus.js `_runtracerAgentInner` ~2390). Only a one-time sudo line is surfaced.
- **Fix:** Local resolver (dnsmasq/hostsfile) the browser uses, or accept the gap (CLI path covers it).

### P3 — Phase-boundary cancel aborts only wired for pentest
- **Symptom:** Belt-and-suspenders only — cancel ALREADY works for all squads via the `spawnAgent`
  chokepoint guard; cloud/network/code-review just lack the explicit pre-phase aborts for faster halt.
- **Fix:** Add `if (_isTaskCancelled(taskId)) { killTaskChildren; return ... }` at the major phase
  boundaries in the other squad dispatchers.

### P3 — Ops: system clock / NTP not synced
- **Symptom:** After reboot the clock was ~22h off; tasks got future timestamps (UI mitigated by the
  active-first sort).
- **Root cause:** `timedatectl: NTP service: inactive` — environment, not code.
- **Fix:** Document `sudo timedatectl set-ntp true` in setup/README.

---

## FIXED (2026-06-29 session)

- ✅ **Agents didn't use `emit-finding`** (findings invisible until Phase 3) — emission is now MANDATORY
  in the prompt (a finding only counts if emitted via the tool); the activity-log echo is demoted to
  progress-only. (event-bus.js `buildPentestSpecialistPrompt`)
- ✅ **Recon re-ran a redundant ~25min full nmap** — the nmap heart-truth prompt block now says the
  `-p-` scan is DONE; agents must not re-run it (only targeted `-sV -sC` on known ports). (nmap-scan.js)
- ✅ **Recon agents over-exploited / starved the run** — recon agents (SCOUT/RANGER) get a scope+time
  boundary in the prompt (map + flag fast, hand depth to Phase 2) AND a hard 15-min watchdog cap (vs
  45min for specialists). (event-bus.js)
- ✅ **Pre-flight `000000` false-reachable + wrong-port** — capture the HTTP code without the `|| echo`
  concat bug; abort only if the HOST is down (no ping), since the app may be on a non-default port that
  nmap finds. (event-bus.js pre-flight)
- ✅ Cancel didn't kill agents (cooperative cancellation: `spawnAgent` guard + phase aborts + status)
- ✅ Watchdog false-killed recon agents (tool activity resets the stall timer)
- ✅ Findings corrupted/dropped in JSONL (tolerant `loose-jsonl` reader + `emit-finding` writer)
- ✅ Board buried new dispatches (active-first sort, clock-skew resilient)
- ✅ crawl4ai failed even when installed (self-spawn when no CDP Chrome)
- ✅ Generate-report produced 0-finding reports (ensureValidatedFindings + early enrich)
- ✅ normalizeFinding could drop a finding with no id (always assigns an id)
- ✅ nmap heart-truth (Phase 0.4) + vhost resolution (Phase 0.45) shipped
