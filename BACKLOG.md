# ARCHON — Bug & Improvement Backlog

Open issues observed during live HTB testing (2026-06-29). Most P1/P2 items fixed; remaining
are lower-priority features/ops. Each item: symptom → root cause (file) → fix.

---

## OPEN

### P3 — SDK adapter doesn't group-kill (deeper orphan fix)
- **Symptom:** The interim orphan-reaper (FIXED below) sweeps leaked `ppid==1` scan tools every 60s,
  but the root cause remains: the default SDK adapter spawns the `claude` subprocess WITHOUT
  `detached`, and its kill = `abortController.abort()` only (no `process.kill(-pid)`).
- **Fix:** Make the SDK-adapter kill path group-kill (agents/runner/adapters/sdk.js), or run tool-heavy
  agents under `ADAPTER=cli` (agents/runner/adapters/cli.js already does `detached:true` + group-kill).
  Lower priority now that the reaper covers it + the watchdog no longer auto-kills.

### P3 — Zero-finding alert only warns, never acts
- **Symptom:** `⚠️ Zero-finding alert: 25min … 0 live findings` fired twice but nothing changed — recon
  kept running to the cap.
- **Root cause:** The alert is informational only (event-bus.js zero-finding watchdog).
- **Fix:** Make it act — e.g. nudge/cut recon, or escalate to Phase 2 — when 0 findings persist past N
  min. (Partially mitigated by the new 15-min recon cap.)

### P3 — No concurrency cap on in-progress engagements
- **Symptom:** Earlier, 4 runs executed at once (from cancel-not-working) and competed for CPU.
- **Root cause:** No max-concurrent-engagements guard; nothing stops N dispatches all spawning fleets.
- **Fix:** A configurable concurrency cap (queue beyond N in-progress). Lower priority now that cancel
  works, but defensive for a public build. (event-bus.js processQueue)

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

- ✅ **Time caps killed working agents** — removed ALL time-based watchdog kills (HARD_MAX, NO_MOVEMENT,
  ACTIVITY_STALL, DONE_GRACE, recon cap); watchdog is now a cancel-responder only. Agents run to
  natural completion; only a user-cancel stops them. (event-bus.js spawnAgent watchdog)
- ✅ **Recon boundary prompt** (forced early stop) removed; activity-log finding logging restored so
  findings flow via AUDITOR like before (emit-finding kept as optional clean path).
- ✅ **Memory write ENOENT** — `writePostTaskMemory` now `mkdir -p`s `memDir/episodes` before writing;
  learning loop persists again.
- ✅ **Orphaned tool processes** — daemon orphan-reaper sweeps `ppid==1` scan tools every 60s.
- ✅ **emit-finding compliance** — activity→live-findings ingester promotes activity findings into the
  structured tab live (15s), so findings show regardless of which path the agent used.

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
