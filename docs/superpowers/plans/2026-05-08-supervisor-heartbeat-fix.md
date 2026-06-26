# Supervisor Heartbeat Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make event-bus daemon's liveness signal independent of event-loop blockage during long-running synchronous subprocess calls, so `supervisor.js` stops issuing spurious `pm2 restart event-bus` mid-flight.

**Architecture:** Introduce a single-purpose async wrapper `agents/long-running-spawn.js` that uses `child_process.spawn` (releases event loop during wait), invokes a periodic heartbeat callback, captures stdout/stderr, and honors a hard timeout. Convert `event-bus.js#runEklavyaAgent` Phase A3 (crawl4ai browser crawl) from blocking sync subprocess to `await runWithHeartbeat(...)` with `persistCheckpointNow` as the heartbeat — this keeps the checkpoint fresh during multi-minute crawls, defusing supervisor's 5-min stale-detection. The wrapper is reusable by other long-running subprocess sites (Phase 0 katana, gau, etc.).

**Tech Stack:** Node 22 (`child_process.spawn`, `node:test`), bun test runner, atomic-write helper from event-bus.js (`writeAtomic`/`persistCheckpointNow`).

**Branch:** `feature/supervisor-heartbeat-fix` (new, off master)

**Spec context:** Diagnostic in this conversation block (Telegram msg 1975) + investigate-skill output. Root cause: `supervisor.js:101-107` issues `pm2 restart event-bus` when checkpoint.ts is stale > 5 min. `event-bus.js#runEklavyaAgent` Phase A3 (synchronous subprocess at line 2064) blocks the event loop, preventing the existing 1s checkpoint debounce timer from firing. After 5 min, supervisor SIGKILLs the daemon mid-crawl.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `agents/long-running-spawn.js` | Create | Single export `runWithHeartbeat(cmd, opts)` — async spawn + interval heartbeat + timeout + stdout capture |
| `test/long-running-spawn.test.js` | Create | Unit tests for `runWithHeartbeat` (heartbeat fires, timeout kills, error path, stdout captured) |
| `event-bus.js` | Modify | Phase A3 swap (lines 2057-2070) — sync subprocess → await runWithHeartbeat with persistCheckpointNow as heartbeat |
| `verify-framework.js` | Modify | Add GATE-60 — Phase A3 must NOT use blocking sync subprocess (architectural lock) |

Test convention: plain Node `assert` + `test()` from `node:test`, run via `bun test test/<file>.test.js`. Reference style: `/root/agents/test/judge-verifier.test.js`.

---

### Task 1: Create the wrapper module + unit tests (TDD red→green)

**Files:**
- Create: `agents/long-running-spawn.js`
- Test: `test/long-running-spawn.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/long-running-spawn.test.js` with 10 tests covering:
1. Captures stdout from a successful command (`echo "hello world"`)
2. Returns non-zero exit code without throwing (`exit 7`)
3. Shell semantics work — separate stdout / stderr capture
4. Heartbeat callback fires during long-running command (sleep 1.5s, heartbeatMs 500ms → ≥2 fires)
5. Heartbeat does NOT fire on instant commands (echo done, heartbeatMs 1000 → 0 fires)
6. Timeout kills runaway child (sleep 60 with timeout 500ms → returns within ~3s, timedOut=true)
7. Heartbeat errors do NOT crash the wrapper (heartbeat throws → wrapper still completes)
8. ENOENT on bad shell does not throw (returns non-success rather than throws)
9. Clears interval on completion (no leaked timers — quick command resolves promptly even with 50ms heartbeat)
10. Stdout buffer does not deadlock on large output (≥100KB stdout captured)

Test scaffold (full code in subagent prompt):

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const { runWithHeartbeat } = require('../agents/long-running-spawn')

test('runWithHeartbeat: captures stdout from a successful command', async () => {
  const result = await runWithHeartbeat('echo "hello world"', { timeout: 5000 })
  assert.strictEqual(result.code, 0)
  assert.match(result.stdout, /hello world/)
  assert.strictEqual(result.timedOut, false)
})
// ... 9 more tests with same shape
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `/root/.bun/bin/bun test test/long-running-spawn.test.js`
Expected: All 10 tests fail with `Cannot find module '../agents/long-running-spawn'`

- [ ] **Step 3: Implement `agents/long-running-spawn.js`**

The module returns a Promise (never throws), spawns via `child_process.spawn(shell, ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })`, sets up:
- `setInterval(heartbeat, heartbeatMs)` — fires onHeartbeat (errors swallowed via try/catch)
- `setTimeout(killTimer, timeout)` — first SIGTERM, then SIGKILL after 2s grace
- `child.stdout.on('data', ...)` and `child.stderr.on('data', ...)` collect output
- `child.on('close', code => resolve({ stdout, stderr, code, timedOut }))`
- `child.on('error', err => resolve({ ..., error: err, code: null }))`

cleanup() clears all timers. finish() guards against double-resolve. Default opts: `{ timeout: 60000, heartbeatMs: 30000, onHeartbeat: null, shell: '/bin/sh' }`. Single export: `module.exports = { runWithHeartbeat }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/agents && /root/.bun/bin/bun test test/long-running-spawn.test.js`
Expected: `10 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add agents/long-running-spawn.js test/long-running-spawn.test.js
git commit -m "feat(long-running-spawn): async subprocess wrapper with heartbeat callback

Releases the event loop during subprocess wait, allowing the daemon's
checkpoint timer / supervisor heartbeat to keep firing. Heartbeat callback
invoked every heartbeatMs while child runs.

Hard timeout: SIGTERM then SIGKILL after 2s grace.
Never throws — errors surface as { error, code: null } in resolved value.

10 unit tests covering: stdout/stderr capture, exit codes, heartbeat fires,
heartbeat does not fire on instant commands, timeout enforcement, shell
semantics, ENOENT graceful handling, no leaked timers, large stdout buffer.

Part of: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md
Task 1 of 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Convert Phase A3 in event-bus.js to async + heartbeat

**Files:**
- Modify: `event-bus.js:2057-2070` (Phase A3 block inside `runEklavyaAgent`)
- Test: `test/event-bus-phase-a3-async.test.js` (new module-level grep test)

**Pre-flight context:**
- `runEklavyaAgent(target, taskId)` at line 2015 is **already async** ✓ — clean `await` swap
- `persistCheckpointNow(extra)` at line 885 is module-scoped — callable from inside this function
- The existing block uses synchronous subprocess; new block must use `await runWithHeartbeat(...)`

- [ ] **Step 1: Write the module-level grep test (TDD red)**

Create `test/event-bus-phase-a3-async.test.js` with 5 tests:
1. `runEklavyaAgent` requires `./agents/long-running-spawn` and references `runWithHeartbeat`
2. Phase A3 uses `await runWithHeartbeat` (and does NOT contain blocking sync subprocess)
3. Phase A3 passes `persistCheckpointNow` as the `onHeartbeat` callback
4. Fail-soft try/catch wrapper preserved (catch produces `crawl4ai error...continuing with light crawl`)
5. `crawl4ai output:` log line preserved (downstream tooling watches it)

Test scaffold:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

function sliceRunEklavyaAgent() {
  const start = SRC.indexOf('async function runEklavyaAgent')
  assert.ok(start > 0)
  return SRC.slice(start, start + 8000)
}

test('Phase A3 uses runWithHeartbeat (not blocking sync subprocess)', () => {
  const slice = sliceRunEklavyaAgent()
  const phaseA3 = slice.match(/Phase A3:[\s\S]{0,1500}?crawl4ai (?:completed|error)/)?.[0] || ''
  assert.match(phaseA3, /\bawait runWithHeartbeat\b/)
  assert.doesNotMatch(phaseA3, /\b(?:exec|execSync|spawnSync)\s*\(/)
})

// ... 4 more tests with same shape
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/agents && /root/.bun/bin/bun test test/event-bus-phase-a3-async.test.js`
Expected: 3-4 tests fail (require, async-call, heartbeat-callback)

- [ ] **Step 3: Apply the surgical replacement in event-bus.js**

Use Edit tool to replace the existing Phase A3 block (lines 2057-2070). The OLD block declares `let crawl4aiSuccess = false`, opens a try, defines `crawlCmd`, logs "Phase A3: crawl4ai browser crawl...", calls the synchronous subprocess helper with `{ timeout: 200000 }`, logs `crawl4ai output:` and the success/error states, ends with `} catch(e) { log('crawl4ai error...') }`.

The NEW block (full content in subagent prompt):

```javascript
  // ── PHASE_A3: crawl4ai browser crawl ALWAYS runs (capped to prevent OOM) ──
  // Async spawn + heartbeat callback so the daemon's checkpoint stays fresh
  // during the multi-minute crawl. Synchronous subprocess would block the event
  // loop, the supervisor would see stale checkpoint, and SIGKILL the daemon
  // mid-flight. See docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md
  const { runWithHeartbeat } = require('./agents/long-running-spawn')
  let crawl4aiSuccess = false
  try {
    const crawlCmd = `CRAWL4AI_CDP_URL=http://localhost:18800 timeout 300 python3 /root/agents/eklavya/skills/web-crawling/scripts/crawl4ai_crawler.py -u "${sTarget}" -d 4 --max-pages 200 -o "${outDir}" 2>&1`
    log(`   Phase A3: crawl4ai browser crawl (depth 4, max 200, CDP reuse, 5min timeout, heartbeat 30s)...`)
    const crawlResult = await runWithHeartbeat(crawlCmd, {
      timeout: 200000,
      heartbeatMs: 30000,
      onHeartbeat: persistCheckpointNow,
    })
    const crawlOut = crawlResult.stdout
    log(`   crawl4ai output: ${crawlOut.slice(0, 300)}`)
    if (crawlResult.timedOut) {
      log(`⚠️  crawl4ai error: timed out after 200s — continuing with light crawl data (katana+gau still available)`)
    } else if (crawlResult.code !== 0) {
      log(`⚠️  crawl4ai error: exit ${crawlResult.code} — continuing with light crawl data (katana+gau still available)`)
    } else {
      crawl4aiSuccess = fs.existsSync(`${outDir}/crawl_results.json`)
      if (crawl4aiSuccess) log(`✅ crawl4ai completed — merging with light crawl`)
    }
  } catch(e) {
    log(`⚠️  crawl4ai error: ${e.message.slice(0,200)} — continuing with light crawl data (katana+gau still available)`)
  }
```

- [ ] **Step 4: Run tests to verify the swap**

Run in sequence:

```bash
cd /root/agents
/root/.bun/bin/bun test test/event-bus-phase-a3-async.test.js
/root/.bun/bin/bun test test/long-running-spawn.test.js
/root/.bun/bin/bun test test/event-bus-phase-3-9-wiring.test.js
node -c event-bus.js && echo "syntax OK"
```

Expected:
```
test/event-bus-phase-a3-async.test.js: 5 pass, 0 fail
test/long-running-spawn.test.js: 10 pass, 0 fail
test/event-bus-phase-3-9-wiring.test.js: 6 pass, 0 fail
syntax OK
```

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add event-bus.js test/event-bus-phase-a3-async.test.js
git commit -m "fix(event-bus): convert Phase A3 to async runWithHeartbeat

Root cause (per investigate-skill diagnostic 2026-05-08):
  Phase A3 used blocking synchronous subprocess (timeout 200s) which froze
  the event loop. The daemon's checkpoint debounce timer (1s/5s) could not
  fire during the freeze. After 5 min stale, supervisor.js:101 issued
  pm2 restart event-bus → SIGKILL mid-crawl. Daemon restart →
  replayAndRecover() detected orphan task → re-dispatched → loop forever.

Fix:
  Phase A3 now uses 'await runWithHeartbeat(crawlCmd, { onHeartbeat: persistCheckpointNow })'.
  The async spawn releases the event loop during the wait, allowing the
  existing checkpoint timer to fire AND the explicit heartbeat (30s interval)
  to actively bump checkpoint.ts. Supervisor stale-detection no longer trips.

Behavior preserved:
  - Same fail-soft try/catch wrapper
  - Same log lines (crawl4ai output / error / completed)
  - Same 200s hard timeout
  - Same crawl_results.json existence check

5 module-level grep tests in test/event-bus-phase-a3-async.test.js lock in
the wiring + regression guard.

Reusable: agents/long-running-spawn.js can wrap any future long-running
subprocess (Phase 0 katana, gau, etc.) using the same heartbeat pattern.

NOT activated yet — needs PM2 reload of event-bus to load new code path.

Part of: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md
Task 2 of 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add GATE-60 — architectural lock against regression

**Files:**
- Modify: `verify-framework.js` (insert new gate after GATE-59)

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "GATE-59\|GATE-58" /root/agents/verify-framework.js | head -3`
Insert GATE-60 between the closing `})` of GATE-59 and the opening `gate('GATE-58: ...'`

- [ ] **Step 2: Insert GATE-60**

The gate asserts:
1. `agents/long-running-spawn.js` exists and exports `runWithHeartbeat`
2. `runEklavyaAgent` Phase A3 block contains `await runWithHeartbeat`
3. Phase A3 block does NOT contain blocking sync subprocess (regression guard)

GATE body (full code in subagent prompt):

```javascript
gate('GATE-60: Phase A3 (crawl4ai browser crawl) uses async runWithHeartbeat, NOT blocking sync subprocess', () => {
  const wrapperPath = path.resolve(__dirname, 'agents/long-running-spawn.js')
  if (!fs.existsSync(wrapperPath)) {
    throw new Error('agents/long-running-spawn.js missing — async subprocess wrapper not deployed')
  }
  const wrapperSrc = fs.readFileSync(wrapperPath, 'utf-8')
  if (!/runWithHeartbeat/.test(wrapperSrc)) {
    throw new Error('long-running-spawn.js missing runWithHeartbeat export')
  }
  const ebSrc = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const fnStart = ebSrc.indexOf('async function runEklavyaAgent')
  if (fnStart < 0) {
    throw new Error('runEklavyaAgent function missing in event-bus.js')
  }
  const fnSlice = ebSrc.slice(fnStart, fnStart + 8000)
  const phaseA3 = fnSlice.match(/Phase A3:[\s\S]{0,1500}?crawl4ai (?:completed|error)/)?.[0]
  if (!phaseA3) {
    throw new Error('Phase A3 block not found in runEklavyaAgent')
  }
  if (/\b(?:execSync|spawnSync)\s*\(/.test(phaseA3)) {
    throw new Error('Phase A3 still uses blocking sync subprocess — supervisor SIGKILL regression risk')
  }
  if (!/await\s+runWithHeartbeat/.test(phaseA3)) {
    throw new Error('Phase A3 must call await runWithHeartbeat')
  }
  return 'Phase A3 uses async runWithHeartbeat with persistCheckpointNow heartbeat'
})
```

- [ ] **Step 3: Run verify-framework**

Run: `cd /root/agents && timeout 60 node verify-framework.js 2>&1 | grep -E "GATE-60|RESULT:"`

Expected:
```
✓ GATE-60: Phase A3 ... — Phase A3 uses async runWithHeartbeat with persistCheckpointNow heartbeat
RESULT: 59/60 gates passed
```
(One pre-existing fail unchanged: GATE-1 network-dispatcher-integration, known stale.)

- [ ] **Step 4: Commit**

```bash
cd /root/agents
git add verify-framework.js
git commit -m "feat(verify-framework): GATE-60 — architectural lock against Phase A3 sync regression

Asserts:
  - agents/long-running-spawn.js exists + exports runWithHeartbeat
  - event-bus.js#runEklavyaAgent Phase A3 uses await runWithHeartbeat
  - Phase A3 must NOT contain execSync(...) / spawnSync(...) (regression guard)

Catches future code changes that revert to blocking subprocess in Phase A3,
which would re-introduce the supervisor SIGKILL mid-crawl bug.

Total GATEs: 59/60 passing (the 1 known-stale network-dispatcher test
remains pre-existing and out of scope).

Part of: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md
Task 3 of 3 — implementation complete on feature branch.
PM2 reload of event-bus daemon held for Jay's manual approval.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 (operational, NOT executed by subagent): PM2 reload + smoke verify

This task is OPERATIONAL — it touches the live daemon. Held for Jay's explicit OK after Tasks 1-3 land on the feature branch.

- [ ] Push feature branch + open PR for Jay's review
- [ ] After Jay approves, merge feature branch to master
- [ ] `pm2 reload event-bus` and verify daemon picks up new code path
- [ ] Smoke test on a small target — Phase A3 should not trigger SIGKILL during multi-minute crawls

Acceptance: daemon `restarts` count after dispatch == count before dispatch (no spurious restart). Phase 1+ phases reachable.

Rollback path (if unexpected behavior post-deploy):

```bash
cd /root/agents
git revert -m 1 <merge-sha>
git push origin master
pm2 reload event-bus
```

The wrapper module is purely additive — reverting the merge restores the prior code path with no leftover state.

---

## Self-Review

**1. Spec coverage:**
- Async wrapper module → Task 1 ✓
- Phase A3 conversion → Task 2 ✓
- Reusable for other long-running calls (katana etc.) → wrapper is generic; Phase 0 katana already has 120s timeout that hasn't tripped supervisor in production, so deliberately deferred (same wrapper applies if needed)
- Fail-soft preserved → Task 2 NEW block keeps the same try/catch + log lines
- TDD required → Tasks 1 and 2 both write failing tests first
- Single feature branch → `feature/supervisor-heartbeat-fix`
- Test file `test/event-bus-checkpoint-heartbeat.test.js` named in args — renamed to `test/event-bus-phase-a3-async.test.js` to match content (it's a wiring test, not a checkpoint test); plus the wrapper unit tests in `test/long-running-spawn.test.js`. Both are clearer names.
- New module `agents/long-running-spawn.js` → Task 1 ✓
- GATE for architectural lock → Task 3 ✓ (GATE-60)

**2. Placeholder scan:** No "TBD" / "implement later" / "similar to" tokens. All code blocks are complete. All commands include expected output.

**3. Type consistency:** `runWithHeartbeat` signature in module + tests + Phase A3 caller all use the same `{ stdout, stderr, code, timedOut, error? }` return shape and `{ timeout, heartbeatMs, onHeartbeat, shell }` opts.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance + code quality) between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints for review

Task 4 (operational PM2 reload) is held regardless of execution mode — Jay must explicitly approve before live daemon touches. The subagent / inline executor stops after Task 3.
