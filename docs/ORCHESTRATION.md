# ARCHON — Orchestration & Operational Health

One map of how a dispatch flows, which model each role uses, the self-monitors that keep it clean, and the
invariants the Operational Supervisor guarantees. For an open-source build that must run cleanly unattended.

## Agent roles & models

| Role | Agents | Model (tier) | Why |
|---|---|---|---|
| **Orchestrator / planner** | ATLAS (pentest), CURATOR (code-review) | **claude-opus-4-8** (`powerful`/xhigh) | Plans the engagement, decides which specialist attacks what — the highest-leverage reasoning. |
| Recon | SCOUT, RANGER | balanced (Sonnet) | Surface mapping + DAST. |
| Specialists | RELAY, VIPER, DRILL, WARDEN, LEDGER, FORGE, SPECTRE, DECOY, VAULT, GATEWAY, SENTRY | balanced (Sonnet) | Per-class vuln discovery + exploitation. |
| Validator | AUDITOR | balanced | Independent confirm of each finding. |
| Reporter | SCRIBE | balanced | Final dossier from confirmed findings. |
| **Operational Supervisor** | (deterministic code, no LLM) | — | Verifies the system's own health every 10s. |
| **SENTINEL** (diagnostic) | one-shot, on anomaly | **claude-opus-4-8** | Reasons about an anomaly the supervisor can't auto-resolve. |

Model routing is config-driven in `var/intel/model-config.json` (`agent_roles` → `role_defaults` → family;
`model-router.js getModelForAgent`). Orchestrators are in `deny_family_downgrade_for` so they stay on Opus.

## Dispatch → report flow

```
UI /api/dispatch → writeInbox(inbox/task-actions)
  → [task-actions watcher, 10s+fswatch] → dispatch-queue.json (pending)
  → [processQueue, 30s+fswatch] pending→processing, backfill tasks.json (in-progress), → dispatchToAgent
  → dispatchToAgent → squad dispatcher (pentest = dispatchPentestParallel)
      Phase 0.0 scope · 0.4 nmap heart-truth · 0.45 vhost/canonical-target · 0 WAF · 0.1 auth · 0.7 complexity
      Phase 1 recon (SCOUT/RANGER) · 1.9 attack-plan (ATLAS/Opus) · 2 specialists · 2.5/2.9
      Phase 3 AUDITOR · 3.05 VALIDATED-FINDINGS · 3.1 enrich (CVSS) · 3.075 severity · 3.6 chains · 3.9 judge
      Phase 4 SCRIBE report
  → done (or awaiting-triage if the operator gate is on → Generate report resumes it)
```

## Cancel

UI /api/cancel → `cancel-signals/` → [watcher, 2s] `processCancelSignals`: kill child agents
(`killTaskChildren`), mark task `cancelled`, mark the dispatch-queue entry `cancelled`, clear
`runningTasks`. The **spawnAgent cancel-guard** (`_isTaskCancelled`) refuses to spawn any new agent for a
cancelled task, and `dispatchPentestParallel` aborts at phase boundaries — so cancel is cooperative and
terminal. Agent **tool** subprocesses (nmap/ffuf) that orphan are reaped by the orphan-reaper.

## Self-monitors (daemon timers)

| Monitor | Interval | Invariant / job |
|---|---|---|
| processQueue | 30s + fswatch | pending→processing under concurrency caps (3/leader, 6 global); stale-recovery |
| task-actions inbox | 10s + fswatch | dispatch → queue (atomic claim, dedup) |
| cancel-signals | 2s + fswatch | kill + mark task & queue cancelled |
| task heartbeat | 45s | freshness side-channel for in-progress tasks |
| stuck-task watchdog | 5min | in-progress + no activity >45min + no agent → re-queue (3×) then fail |
| orphan-reaper | 60s | SIGKILL ppid==1 scan tools (leaked agent tools) |
| activity→findings ingester | 15s | promote ACTIVITY-LOG findings → live-findings (tab visibility) |
| **Operational Supervisor** | **10s** | aggregate ALL invariants → `health.json`; auto-heal zombie-cancel; escalate to SENTINEL |
| handoff sweep | 30s | cross-squad A2A handoffs |
| checkpoint persist | 60s | runningAgents/Tasks → checkpoint.json |

## Operational Supervisor — invariants (`src/ops/supervisor.js`, surfaced at `/api/health` + Overview card)

- **cancel_integrity** — a `cancelled` task has no live agents. *Auto-heal:* re-issue cancel (the gap the others missed).
- **queue_integrity** — no `processing` entry >15min with no live agent (processQueue reclaims; supervisor surfaces).
- **dispatch_integrity** — every active dispatch has a task (processQueue backfills).
- **heartbeat_integrity** — an `in-progress` task with a stale heartbeat AND no live agent is flagged dead (stuck-watchdog fails it). NOT a time-cap — only fires when nothing is alive.
- **orphan_tools** — count of leaked ppid==1 scan tools (reaper kills them).

Each pass writes `var/intel/health.json` `{ok, checks[], queue, tasks, recentFixes[], anomalies[], sentinel?}`.
An anomaly the supervisor can't auto-resolve (or that recurs) triggers ONE Opus **SENTINEL** diagnostic
(rate-limited ≤1 / signature / 15min) whose root-cause note lands in `health.json.sentinel`.

## Design notes
- No time limits kill a working agent (removed 2026-06-29) — an agent runs to natural completion; only a
  user-cancel or a true-dead detection stops it.
- The Supervisor **aggregates + fills gaps + reports** — it does not duplicate the existing watchdogs' fixes.
