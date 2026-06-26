# G3: TrajAD Runtime Rollback — Design Spec

**Status:** 🟡 SPEC DRAFTED — awaiting Jay's approval
**Layer:** B (Trajectory Discipline)
**Source:** Architecture vision §4 Layer B; TrajAD ("Trajectory Anomaly Detection") research from arxiv:2410.12345
**Estimated effort:** 4 days build + 2 days observation = 6 days
**Estimated win:** Catch ~20% of specialist reasoning errors at runtime BEFORE they pollute downstream phases

---

## 1. Problem

A specialist agent (e.g., DURYODHANA pentest analyst) produces 12 findings during Phase 3. Some findings are based on flawed reasoning — wrong assumption, hallucinated endpoint, mis-read curl output. Today, those flawed findings flow forward into KRIPA (validation), Phase 3.6 (chain-verifier), Phase 3.8 (browser-verifier), Phase 3.9 (judge-verifier), then VYASA's final report. By the time we catch the error, ~$50 of compute has been wasted on a bad seed.

**Goal:** detect specialist reasoning anomalies WITHIN the specialist's own execution, while it can still be re-prompted or replaced — not after the entire pipeline has run.

## 2. The TrajAD pattern

TrajAD frames an agent's reasoning as a *trajectory* — an ordered sequence of (thought, action, observation) tuples. Anomalies appear as deviations from typical trajectories: looping on a single hypothesis, jumping to a finding without supporting observation, contradicting an earlier observation, etc.

In our system, every agent already emits ACTIVITY-LOG entries that approximate this trajectory:
```
{"agent":"DURYODHANA","action":"REASON","details":"considering SQL injection at /search","ts":"..."}
{"agent":"DURYODHANA","action":"EXEC","details":"curl '/search?q=test","ts":"..."}
{"agent":"DURYODHANA","action":"OBSERVE","details":"HTTP 200, 2453 bytes","ts":"..."}
{"agent":"DURYODHANA","action":"FINDING","details":"SQL injection confirmed","ts":"..."}
```

A trajectory checker runs alongside the specialist (or polls every N seconds) and applies anomaly detectors to the recent window of entries.

## 3. Anomaly detectors (start with these 4)

| Detector | What it catches | Action |
|---|---|---|
| **A1: Finding-without-observation** | Specialist emits FINDING action with no preceding EXEC/OBSERVE supporting it | Flag finding as `trajectory_unsupported`, force VYASA to omit |
| **A2: Loop-on-same-hypothesis** | ≥5 REASON actions about the same hypothesis without any new EXEC | Inject prompt: "you've been looping on X — try a different angle or move on" |
| **A3: Observation-contradicting-finding** | EXEC returns 404, finding claims endpoint exists | Flag as `trajectory_contradiction`, downgrade severity |
| **A4: Cost-vs-progress-divergence** | Specialist has spent >$10 with 0 findings AND 0 successful EXECs | Hard-stop, replace with a fresh dispatch |

These are intentionally simple. More sophisticated TrajAD-style ML detectors come later if these provide value.

## 4. Architecture

### 4.1 New module: `agents/trajectory-checker.js`

Stateless module reading from ACTIVITY-LOG.jsonl:

```javascript
async function checkTrajectory(agentName, taskId, opts) {
  const recentWindow = readActivityLogWindow(agentName, taskId, opts.windowSeconds || 300)
  const anomalies = []
  if (detectA1(recentWindow)) anomalies.push({ id: 'A1', ... })
  if (detectA2(recentWindow)) anomalies.push({ id: 'A2', ... })
  if (detectA3(recentWindow)) anomalies.push({ id: 'A3', ... })
  if (detectA4(recentWindow)) anomalies.push({ id: 'A4', ... })
  return { anomalies, recommendation: deriveRecommendation(anomalies) }
}
```

### 4.2 Runtime hook: poll every 60s for active specialists

In event-bus.js, a setInterval loop checks each in-flight specialist. On anomaly:

| Recommendation | Action |
|---|---|
| `flag_finding` (A1, A3) | Write marker to /root/intel/TRAJECTORY-ANOMALIES-{taskId}.jsonl. VYASA reads + omits/downgrades. |
| `inject_redirect_prompt` (A2) | Append a redirect prompt via `claude --message` to running agent. (Phase 3+ — needs ACP) |
| `hard_stop_and_redispatch` (A4) | Kill specialist subprocess. Re-spawn with same prompt + extra "previous attempt diverged" context. |

For MVP, only `flag_finding` is implemented. A2/A4 actions are documented but deferred to Phase 2.

### 4.3 GATE-60

```javascript
gate('GATE-60: trajectory anomalies — when present, VYASA reports must not include flagged findings as confirmed')
```

## 5. MVP scope (this spec, 4 days)

- `agents/trajectory-checker.js` with detectors A1 + A3 only (the cheap/structural ones)
- `scripts/run-trajectory-checker.js` CLI for retro analysis
- 12 unit tests covering detectors + edge cases
- 1 integration test on synthetic ACTIVITY-LOG fixtures
- GATE-60

## 6. Phase 2 (later, separate spec)

- A2 + A4 detectors (require live agent intervention via ACP — Agent Communication Protocol)
- Runtime hook in event-bus.js (60s interval poller)
- VYASA prompt update to consume TRAJECTORY-ANOMALIES file
- Real-pentest A/B comparison: anomaly-flagged vs not

## 7. Anti-patterns explicit

- ❌ **Don't auto-correct findings.** The checker FLAGS only. Auto-correction creates a feedback loop where the checker becomes the analyst.
- ❌ **Don't use ML for MVP.** A1/A3 are simple structural checks. Don't reach for embeddings/classifiers when string matching works.
- ❌ **Don't gate the pipeline on trajectory checks.** They're advisory. A flagged finding may still be a real bug. VYASA decides based on the flag + other evidence.

## 8. Why this matters

Today's verification spine catches errors at downstream phases (chain-verifier, browser-verifier, judge-verifier). All of those run AFTER the specialist has finished. Trajectory checking catches errors WHILE the specialist is reasoning — earlier signal, cheaper recovery.

Combined with G1 Judge Verifier (independent post-finding validation) and G4 Multi-Model Test (per-agent model right-sizing), trajectory checking forms the third leg of the Verification Spine: **fast (<60s), narrow (per-agent), recoverable (flag-not-fail).**

## 9. Approval gate

Per Plan-First rule, this spec needs Jay's "ok" before code is written.

This is a NET-NEW pattern, not a continuation of existing approved work. Higher bar than G1 Phase 2 (which built on already-validated MVP). Suggest discussion before commit.
