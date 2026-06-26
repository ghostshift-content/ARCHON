# Framework Gaps Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 framework gaps surfaced by the 2026-04-26 ENBD pentest verification — URL parsing regex priority bug, spot-check feedback loop wiring, and chain-verifier test coverage — by introducing two pure-function helper modules and rewiring the relevant event-bus.js sites.

**Architecture:** Two new single-responsibility modules (`url-extractor.js`, `early-exit-decision.js`) replace inline logic at the gap sites. event-bus.js is rewired at 4 specific line ranges (3 URL-extraction sites, 1 early-exit decision block, 1 spot-check caller). The pentest specialist prompt builder gains an optional `missedSignals` argument that injects a fenced "RECON SPOT-CHECK MISSED SIGNALS" section. Two new framework-verify gates lock in the invariants. Memory entry captures the regression class.

**Tech Stack:** Node.js (CommonJS), bun test runner, plain `assert` + `test(name, fn)` helper convention (mirror `/root/agents/test/chain-verifier.test.js`).

**Spec:** `/root/agents/docs/superpowers/specs/2026-04-27-framework-gaps-design.md`

**Pre-flight check (run before starting any task):**

Confirm working tree state and that the new test paths don't yet exist:

```bash
cd /root/agents
git status -s | grep -v "^??" | head -5
ls test/url-extractor.test.js test/early-exit-decision.test.js 2>&1 | head -5
```

Expected: working tree has lots of `M memory/grades.json` runtime drift (leave it alone, it's not your concern). The two test files should not yet exist — you'll create them.

---

## Task 1: Create `url-extractor.js` test file

**Files:**
- Create: `test/url-extractor.test.js`
- Test: `bun test test/url-extractor.test.js`

- [ ] **Step 1.1: Write the failing test**

Save this content to `/root/agents/test/url-extractor.test.js`:

```javascript
#!/usr/bin/env node
// Unit tests for /root/agents/url-extractor.js
// Run: bun test test/url-extractor.test.js

const assert = require('assert')
const { extractTargetUrl } = require('../url-extractor')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

console.log('url-extractor tests:')

test('extracts https:// from title (regression: pentest #1 msi.emiratesnbd.com)', () => {
  const out = extractTargetUrl({ taskTitle: 'Pentest H1-ENBD — https://msi.emiratesnbd.com (KRISHNA full pipeline)' })
  assert.strictEqual(out, 'https://msi.emiratesnbd.com')
})

test('https:// in goal beats bare-domain in title (Gap 2 fix)', () => {
  const out = extractTargetUrl({
    taskTitle: 'Pentest H1-ENBD — politemail-read.emiratesnbd.com (KRISHNA full pipeline)',
    goal: 'Web application pentest of https://politemail-read.emiratesnbd.com — full surface',
  })
  assert.strictEqual(out, 'https://politemail-read.emiratesnbd.com')
})

test('bare domain falls back to https:// (no longer http://)', () => {
  const out = extractTargetUrl({ taskTitle: 'Pentest of example.com', goal: 'just a bare domain' })
  assert.strictEqual(out, 'https://example.com')
})

test('explicit http:// is preserved (rare HTTP-only targets)', () => {
  const out = extractTargetUrl({ goal: 'CTF target at http://lab.local' })
  assert.strictEqual(out, 'http://lab.local')
})

test('returns null when no URL anywhere', () => {
  const out = extractTargetUrl({ taskTitle: 'Generic task', goal: 'no url here' })
  assert.strictEqual(out, null)
})

test('strips trailing comma', () => {
  const out = extractTargetUrl({ goal: 'See https://example.com, then probe deeper' })
  assert.strictEqual(out, 'https://example.com')
})

test('strips trailing paren and period', () => {
  const out = extractTargetUrl({ goal: 'Visit (https://example.com).' })
  assert.strictEqual(out, 'https://example.com')
})

test('first scheme match wins when multiple URLs present', () => {
  const out = extractTargetUrl({
    taskTitle: 'Compare https://primary.com to https://secondary.com',
  })
  assert.strictEqual(out, 'https://primary.com')
})

test('email-style strings do NOT pollute scheme match', () => {
  const out = extractTargetUrl({
    goal: 'Contact vdp@emiratesnbd.com — also test https://politemail-read.emiratesnbd.com',
  })
  assert.strictEqual(out, 'https://politemail-read.emiratesnbd.com')
})

test('uses dispatch.title alias when taskTitle absent', () => {
  const out = extractTargetUrl({ title: 'https://aliased.com' })
  assert.strictEqual(out, 'https://aliased.com')
})

test('handles missing fields gracefully', () => {
  assert.strictEqual(extractTargetUrl(null), null)
  assert.strictEqual(extractTargetUrl(undefined), null)
  assert.strictEqual(extractTargetUrl({}), null)
})

test('UAE/SA TLDs supported for ENBD-class targets', () => {
  const out = extractTargetUrl({ goal: 'target is bank.ae' })
  assert.strictEqual(out, 'https://bank.ae')
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
```

- [ ] **Step 1.2: Run test to verify it fails (module not yet created)**

Run: `cd /root/agents && bun test test/url-extractor.test.js`
Expected: FAIL with `Cannot find module '../url-extractor'`

- [ ] **Step 1.3: Commit the failing test**

```bash
cd /root/agents
git add test/url-extractor.test.js
git commit -m "test: add url-extractor failing tests (Gap 2 — regex priority + scheme default)"
```

---

## Task 2: Create `url-extractor.js` implementation

**Files:**
- Create: `url-extractor.js`
- Test: `bun test test/url-extractor.test.js`

- [ ] **Step 2.1: Write the implementation**

Save this content to `/root/agents/url-extractor.js`:

```javascript
// /root/agents/url-extractor.js
//
// Extract a single target URL from a dispatch (taskTitle + description + goal).
// Replaces three duplicated regex sites in event-bus.js (lines 3731, 6066, 7560).
//
// Priority order:
//   1. Any `https://...` or `http://...` URL anywhere in the combined text wins.
//      First scheme-prefixed match wins (left-to-right).
//   2. If no scheme-prefixed URL is present, fall back to first bare-domain match
//      against a known TLD allowlist (com|net|org|io|dev|app|xyz|co|ae|sa).
//      Bare matches get `https://` prefix (banking targets are HTTPS-only).
//   3. If nothing matches, return null.
//
// Trailing punctuation (`,`, `)`, `.`) is stripped from the matched URL.

const SCHEME_RE = /https?:\/\/[^\s'"<>)]+/i
const BARE_RE = /\b[\w.-]+\.(?:com|net|org|io|dev|app|xyz|co|ae|sa)\b/i

function extractTargetUrl(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return null
  const parts = [
    dispatch.taskTitle || dispatch.title || '',
    dispatch.description || '',
    dispatch.goal || '',
  ]
  const combined = parts.filter(Boolean).join(' ')
  if (!combined) return null

  const schemeMatch = combined.match(SCHEME_RE)
  if (schemeMatch) {
    return _stripPunct(schemeMatch[0])
  }
  const bareMatch = combined.match(BARE_RE)
  if (bareMatch) {
    return `https://${_stripPunct(bareMatch[0])}`
  }
  return null
}

function _stripPunct(url) {
  return url.replace(/[,).]+$/, '')
}

module.exports = { extractTargetUrl }
```

- [ ] **Step 2.2: Run test to verify it passes**

Run: `cd /root/agents && bun test test/url-extractor.test.js`
Expected: `12 passed, 0 failed`. Exit code 0.

- [ ] **Step 2.3: Commit the implementation**

```bash
cd /root/agents
git add url-extractor.js
git commit -m "feat(pentest): url-extractor module — fixes Gap 2 (regex priority + https default)"
```

---

## Task 3: Create `early-exit-decision.js` test file

**Files:**
- Create: `test/early-exit-decision.test.js`
- Test: `bun test test/early-exit-decision.test.js`

- [ ] **Step 3.1: Write the failing test**

Save this content to `/root/agents/test/early-exit-decision.test.js`:

```javascript
#!/usr/bin/env node
// Unit tests for /root/agents/early-exit-decision.js
// Run: bun test test/early-exit-decision.test.js

const assert = require('assert')
const { shouldEarlyExit, MISSED_SIGNAL_THRESHOLD, decisions } = require('../early-exit-decision')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

console.log('early-exit-decision tests:')

test('exposes the four decision constants', () => {
  assert.strictEqual(decisions.CONTINUE, 'CONTINUE')
  assert.strictEqual(decisions.CONTINUE_WITH_HINTS, 'CONTINUE_WITH_HINTS')
  assert.strictEqual(decisions.CONTINUE_WITH_HINTS_REACHCHECK, 'CONTINUE_WITH_HINTS_REACHCHECK')
  assert.strictEqual(decisions.EARLY_EXIT, 'EARLY_EXIT')
})

test('threshold is 3', () => {
  assert.strictEqual(MISSED_SIGNAL_THRESHOLD, 3)
})

test('endpoints > 0 → CONTINUE regardless of other signals', () => {
  const r = shouldEarlyExit({ endpointCount: 5, targetReachable: false, missedSignalsCount: 0 })
  assert.strictEqual(r.decision, 'CONTINUE')
  assert.strictEqual(r.reason, 'endpoints_found')
})

test('0 endpoints + reachable + 0 misses → CONTINUE (SPA path)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 0 })
  assert.strictEqual(r.decision, 'CONTINUE')
  assert.strictEqual(r.reason, 'target_reachable_no_endpoints')
})

test('0 endpoints + reachable + 3 misses → CONTINUE_WITH_HINTS (Gap 1 fix)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 3 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS')
  assert.strictEqual(r.reason, '3_missed_signals')
})

test('0 endpoints + reachable + 10 misses → CONTINUE_WITH_HINTS (politemail case)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 10 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS')
  assert.strictEqual(r.reason, '10_missed_signals')
})

test('0 endpoints + unreachable + 5 misses → CONTINUE_WITH_HINTS_REACHCHECK', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: false, missedSignalsCount: 5 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS_REACHCHECK')
  assert.strictEqual(r.reason, '5_signals_unreachable_recheck_scheme')
})

test('0 endpoints + unreachable + <3 misses → EARLY_EXIT (truly dead target)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: false, missedSignalsCount: 0 })
  assert.strictEqual(r.decision, 'EARLY_EXIT')
  assert.strictEqual(r.reason, 'no_endpoints_unreachable_no_signals')
})

test('threshold edge: exactly 2 misses + reachable → CONTINUE without hints', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 2 })
  assert.strictEqual(r.decision, 'CONTINUE')
})

test('threshold edge: exactly 3 misses + reachable → CONTINUE_WITH_HINTS', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 3 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS')
})

test('default values when params omitted → EARLY_EXIT', () => {
  const r = shouldEarlyExit()
  assert.strictEqual(r.decision, 'EARLY_EXIT')
})

test('partial params: only endpointCount given → CONTINUE if positive', () => {
  const r = shouldEarlyExit({ endpointCount: 1 })
  assert.strictEqual(r.decision, 'CONTINUE')
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `cd /root/agents && bun test test/early-exit-decision.test.js`
Expected: FAIL with `Cannot find module '../early-exit-decision'`

- [ ] **Step 3.3: Commit the failing test**

```bash
cd /root/agents
git add test/early-exit-decision.test.js
git commit -m "test: add early-exit-decision failing tests (Gap 1 — spot-check feedback gating)"
```

---

## Task 4: Create `early-exit-decision.js` implementation

**Files:**
- Create: `early-exit-decision.js`
- Test: `bun test test/early-exit-decision.test.js`

- [ ] **Step 4.1: Write the implementation**

Save this content to `/root/agents/early-exit-decision.js`:

```javascript
// /root/agents/early-exit-decision.js
//
// Pure function: given recon outcome signals, decide whether to early-exit
// the pentest pipeline (skip specialist phases) or continue.
//
// Rules (first matching wins):
//   1. endpointCount > 0 → CONTINUE
//   2. targetReachable AND missedSignalsCount >= 3 → CONTINUE_WITH_HINTS
//   3. targetReachable AND missedSignalsCount < 3 → CONTINUE
//   4. !targetReachable AND missedSignalsCount >= 3 → CONTINUE_WITH_HINTS_REACHCHECK
//   5. otherwise → EARLY_EXIT

const CONTINUE = 'CONTINUE'
const CONTINUE_WITH_HINTS = 'CONTINUE_WITH_HINTS'
const CONTINUE_WITH_HINTS_REACHCHECK = 'CONTINUE_WITH_HINTS_REACHCHECK'
const EARLY_EXIT = 'EARLY_EXIT'

const MISSED_SIGNAL_THRESHOLD = 3

function shouldEarlyExit({ endpointCount = 0, targetReachable = false, missedSignalsCount = 0 } = {}) {
  if (endpointCount > 0) {
    return { decision: CONTINUE, reason: 'endpoints_found' }
  }
  if (targetReachable) {
    if (missedSignalsCount >= MISSED_SIGNAL_THRESHOLD) {
      return { decision: CONTINUE_WITH_HINTS, reason: `${missedSignalsCount}_missed_signals` }
    }
    return { decision: CONTINUE, reason: 'target_reachable_no_endpoints' }
  }
  if (missedSignalsCount >= MISSED_SIGNAL_THRESHOLD) {
    return { decision: CONTINUE_WITH_HINTS_REACHCHECK, reason: `${missedSignalsCount}_signals_unreachable_recheck_scheme` }
  }
  return { decision: EARLY_EXIT, reason: 'no_endpoints_unreachable_no_signals' }
}

module.exports = {
  shouldEarlyExit,
  MISSED_SIGNAL_THRESHOLD,
  decisions: { CONTINUE, CONTINUE_WITH_HINTS, CONTINUE_WITH_HINTS_REACHCHECK, EARLY_EXIT },
}
```

- [ ] **Step 4.2: Run test to verify it passes**

Run: `cd /root/agents && bun test test/early-exit-decision.test.js`
Expected: `12 passed, 0 failed`. Exit code 0.

- [ ] **Step 4.3: Commit the implementation**

```bash
cd /root/agents
git add early-exit-decision.js
git commit -m "feat(pentest): early-exit-decision module — fixes Gap 1 (spot-check gating)"
```

---

## Task 5: Wire `extractTargetUrl` into event-bus.js (3 sites — Gap 2 fix)

**Files:**
- Modify: `event-bus.js:3731-3733` (pentest dispatch)
- Modify: `event-bus.js:6066-6067` (second site)
- Modify: `event-bus.js:7560-7563` (third site)
- Add require alongside other agent helpers near the top

- [ ] **Step 5.1: Add require near top of event-bus.js**

Use the `Edit` tool. Find this string in `/root/agents/event-bus.js` (around line 35):

`const langfuse = (() => { try { return require('./langfuse-tracer') } catch { return { isEnabled: () => false, traceStart: () => {}, traceEnd: () => {}, spanStart: () => null, spanEnd: () => {} } } })()`

Replace with that same line followed by:

```javascript

// (2026-04-27) URL extraction helper — replaces 3 duplicated inline regex sites
// (was 3731, 6066, 7560). Fixes Gap 2: scheme-prefixed URLs in goal beat bare
// domains in title; bare-domain fallback now uses https:// (was http://).
const { extractTargetUrl } = require('./url-extractor')
```

- [ ] **Step 5.2: Replace site #1 — pentest dispatch (line 3731-3733)**

Read the current block first to confirm line numbers haven't shifted:

Run: `sed -n '3729,3735p' /root/agents/event-bus.js`

Use `Edit` to replace the 4-line block (the comment + the 3-line regex/match/prefix logic) with:

```javascript
  // (2026-04-27) Use shared extractor — see url-extractor.js. Fixes the
  // pre-fix bug where bare-domain matches in the title silently won over
  // scheme-prefixed URLs later in the goal text, and the bare-domain
  // fallback unconditionally added http:// (broke HTTPS-only targets).
  const targetUrl = extractTargetUrl({ taskTitle, description: dispatch.description, goal: dispatch.goal }) || 'UNKNOWN_TARGET'
```

The `old_string` you pass to `Edit` must match the existing 4 lines verbatim — read them with `sed` first, copy exactly, then perform the swap.

- [ ] **Step 5.3: Replace site #2 (around line 6066-6067)**

Run: `sed -n '6064,6070p' /root/agents/event-bus.js`

Use `Edit` to replace the 2-line `targetMatch` + `targetUrl` block at this site with:

```javascript
      // (2026-04-27) Use shared extractor.
      const targetUrl = extractTargetUrl({ taskTitle, description: dispatch.description, goal: dispatch.goal }) || 'UNKNOWN'
```

- [ ] **Step 5.4: Replace site #3 (around line 7560-7563)**

Run: `sed -n '7558,7566p' /root/agents/event-bus.js`

Use `Edit` to replace the 4-line block (`targetMatch` extraction + `rawTarget` + `if (rawTarget)` + `target = rawTarget.startsWith ...` lines) with:

```javascript
      // (2026-04-27) Use shared extractor.
      const target = extractTargetUrl({ taskTitle, description: dispatch.description, goal: dispatch.goal })
      if (target) {
```

- [ ] **Step 5.5: Verify no buggy regex literal remains**

Run: `grep -c "match(/https?:[\\\\]/[\\\\]/" /root/agents/event-bus.js || echo 0`
Expected: `0` (zero matches — all 3 sites replaced).

Also verify the require landed:
Run: `grep -c "require('./url-extractor')" /root/agents/event-bus.js`
Expected: `1`.

- [ ] **Step 5.6: Run all unit tests to confirm no regression**

Run: `cd /root/agents && bun test test/`
Expected: 29/30 files pass. The pre-existing `network-dispatcher-integration.test.js` chainVerifier-deps assertion remains stale (out of scope for this work).

If unrelated tests fail, STOP and investigate before committing.

- [ ] **Step 5.7: Commit Gap 2 wiring**

```bash
cd /root/agents
git add event-bus.js
git commit -m "fix(pentest): wire extractTargetUrl into event-bus.js — Gap 2 fix landed

Replaces 3 duplicated inline regex sites (lines 3731, 6066, 7560) with the
shared extractTargetUrl helper. The pre-fix regex returned the FIRST
left-to-right alternative match, so a bare domain in the taskTitle silently
beat an https:// URL later in the goal — caused the 2026-04-26 politemail-read
scheme downgrade and consequent early-exit."
```

---

## Task 6: Wire `shouldEarlyExit` + capture spot-check misses (Gap 1 fix)

**Files:**
- Modify: `event-bus.js:4081` (capture misses)
- Modify: `event-bus.js:4093-(end of early-exit block)` (decision branch)
- Add require alongside extractTargetUrl

- [ ] **Step 6.1: Add require for early-exit-decision**

Use `Edit`. Find the line you added in Task 5.1 (`const { extractTargetUrl } = require('./url-extractor')`). Replace that line with itself + this addition:

```javascript
const { extractTargetUrl } = require('./url-extractor')

// (2026-04-27) Early-exit decision helper — gates pipeline branch on
// spot-check missed-signals count + reachability. Fixes Gap 1 where the
// runReconSpotCheck return value was discarded.
const { shouldEarlyExit, decisions: EARLY_EXIT_DECISIONS } = require('./early-exit-decision')

// Per-task storage for spot-check misses so the prompt builder can pull
// them when CONTINUE_WITH_HINTS branches dispatch specialists.
const _taskMissedSignals = {}
```

- [ ] **Step 6.2: Capture misses from runReconSpotCheck (line 4081)**

Read the current Phase 1.5 block:

Run: `sed -n '4076,4090p' /root/agents/event-bus.js`

Identify the bare `await runReconSpotCheck({ taskId, targetUrl, squad, projectId, endpointMapFile })` call.

Use `Edit` to replace the entire `try { const currentScore = ...; if (currentScore < 4) { ...await runReconSpotCheck...; } else { log(...skipped...) } } catch (spotErr) { log(...) }` block with:

```javascript
    let _spotCheckMisses = []
    try {
      const currentScore = _getTaskComplexityScore(taskId)
      if (currentScore < 4) {
        log(`🔎 Phase 1.5: Spot-checking Haiku recon output (complexity=${currentScore})`)
        const spotResult = await runReconSpotCheck({ taskId, targetUrl, squad, projectId, endpointMapFile })
        _spotCheckMisses = (spotResult && Array.isArray(spotResult.misses)) ? spotResult.misses : []
        if (_spotCheckMisses.length > 0) {
          _taskMissedSignals[taskId] = _spotCheckMisses
        }
      } else {
        log(`↷ Phase 1.5 skipped: complexity=${currentScore} — specialists are bumped to Sonnet+high, spot check redundant`)
      }
    } catch (spotErr) {
      log(`⚠️ Spot check failed: ${spotErr.message} — continuing to Phase 2`)
    }
```

The key change: `_spotCheckMisses` array is declared OUTSIDE the try (so the next block can read it), and the `await runReconSpotCheck(...)` line is bound to `const spotResult` whose `misses` field is captured.

- [ ] **Step 6.3: Replace the early-exit decision block**

Read the current early-exit block in full first — it's roughly lines 4093 through the end of the `if (!targetReachable) { ... }` body. The body inside that `if` includes: `log("⏭️ Early exit ...")`, the `logActivity('SANJAY', '⏭️ No testable endpoints ...')` call, the dispatch-flag-as-unreachable block (`readJSON(DISPATCH_FILE)` ... `writeJSON(DISPATCH_FILE, queue)`), the DHARMA `buildPentestSpecialistPrompt('dharma', ...)` + `spawnAgent('dharma', ...)` calls, the VYASA `buildVyasaReportPrompt(...)` + `spawnAgent(PENTEST_REPORTER, ...)` calls, and any tail (return / continue / fall-through after VYASA).

Run: `sed -n '4091,4180p' /root/agents/event-bus.js | head -90`

**You MUST keep the body of the EARLY_EXIT branch (DHARMA + VYASA + flag-unreachable + tail) verbatim — only the OUTER decision logic changes.** Copy the existing inner body lines as you read them; do NOT invent them.

Use `Edit` to replace the OUTER block. The structure of the new code is:

```javascript
    // (2026-04-27) Early-exit decision via shared helper. Gates on three signals:
    // endpoint count from crawler, target reachability, and spot-check missed
    // signal count. Replaces the prior endpointCount + reachability-only logic.
    const endpointFile = `/root/intel/pentest-endpoints-${taskId}.json`
    let endpointCount = 0
    try {
      const eps = JSON.parse(fs.readFileSync(endpointFile, 'utf-8'))
      endpointCount = (eps.endpoints || []).length
    } catch {}

    let targetReachable = false
    /* preserve the existing reachability probe block here verbatim — it uses
       the existing execSync-based curl pattern from the original code. Read
       it from the sed output above and paste it unchanged. The block sets
       targetReachable=true|false and logs the HTTP code. */

    const decision = shouldEarlyExit({
      endpointCount,
      targetReachable,
      missedSignalsCount: _spotCheckMisses.length,
    })
    log(`🧭 Pipeline decision: ${decision.decision} (${decision.reason})`)
    logActivity('SANJAY', `🧭 Pipeline decision: ${decision.decision}`, {
      type: 'pipeline-decision', squad, taskId, projectId: projectId || '',
      details: `Decision: ${decision.decision}\nReason: ${decision.reason}\nendpoints=${endpointCount} reachable=${targetReachable} missedSignals=${_spotCheckMisses.length}`,
    })

    if (decision.decision === EARLY_EXIT_DECISIONS.CONTINUE_WITH_HINTS_REACHCHECK) {
      // One-shot scheme swap: try alt scheme on the same host. If reachable, mutate targetUrl and continue.
      const altUrl = targetUrl.startsWith('https://')
        ? targetUrl.replace('https://', 'http://')
        : (targetUrl.startsWith('http://') ? targetUrl.replace('http://', 'https://') : null)
      if (altUrl) {
        let altReachable = false
        /* preserve the existing reachability probe pattern here, this time
           probing altUrl. Reuse the same execSync + safeUrl + status-code
           whitelist as the original probe. Set altReachable accordingly. */
        if (altReachable) {
          log(`🔁 Alt-scheme reachable — swapping ${targetUrl} → ${altUrl} and continuing with hints`)
          logActivity('SANJAY', `🔁 Scheme swap: ${targetUrl} → ${altUrl}`, {
            type: 'scheme-swap', squad, taskId, projectId: projectId || '',
          })
          targetUrl = altUrl
          // Fall through to CONTINUE branch by NOT entering EARLY_EXIT below.
        } else {
          log(`🔁 Alt-scheme also unreachable — falling through to early-exit`)
          decision.decision = EARLY_EXIT_DECISIONS.EARLY_EXIT
          decision.reason = `${decision.reason}_alt_scheme_also_unreachable`
        }
      }
    }

    if (decision.decision === EARLY_EXIT_DECISIONS.EARLY_EXIT) {
      log(`⏭️ Early exit: ${decision.reason} — skipping specialist phases`)
      /* paste the existing EARLY-EXIT body VERBATIM here:
         - logActivity('SANJAY', '⏭️ No testable endpoints found AND target unreachable — limited assessment only', {...})
         - readJSON(DISPATCH_FILE) → set unreachableExit=true → writeJSON
         - log('🔄 Early exit: Running DHARMA (headers only) + VYASA report')
         - buildPentestSpecialistPrompt('dharma', ...) + spawnAgent('dharma', ...) + trackCosts
         - buildVyasaReportPrompt(...) + spawnAgent(PENTEST_REPORTER, ...) + trackCosts
         - Whatever tail comes after VYASA (return / continue / fall-through) — copy it.
      */
    }

    // CONTINUE / CONTINUE_WITH_HINTS / (post-swap) CONTINUE_WITH_HINTS_REACHCHECK
    // all fall through to the existing Phase 2 specialist dispatch below.
```

**Important executor note:** The `/* preserve ... */` placeholder regions are NOT meant to ship as comments. Read the existing source with `sed` and paste the actual lines into those slots. Verify after the edit that the file still parses with `node -c /root/agents/event-bus.js` (or equivalent) before moving on.

- [ ] **Step 6.4: Sanity-check the file parses**

Run: `node -e "require('/root/agents/event-bus.js')" 2>&1 | head -20`
Note: this will likely error on missing globals (the file isn't designed to be `require`d standalone). What you're checking for is **syntax errors** — if you see `SyntaxError`, the edit broke parsing. Anything else (missing module, undefined variable at runtime) is fine — that's expected for partial-load.

A cleaner check: `bun --bun-check /root/agents/event-bus.js 2>&1 | tail -3` if available. Otherwise just run the unit tests in 6.5.

- [ ] **Step 6.5: Run all unit tests**

Run: `cd /root/agents && bun test test/`
Expected: 29/30 files pass.

- [ ] **Step 6.6: Quick sanity grep — confirm misses are captured + threaded**

Run: `grep -nE "spotResult\\.misses|_spotCheckMisses|_taskMissedSignals" /root/agents/event-bus.js | head -10`
Expected: at least 4 hits (declaration of `_taskMissedSignals`, capture line, store line, decision-call line). If fewer, you missed wiring.

- [ ] **Step 6.7: Commit Gap 1 wiring**

```bash
cd /root/agents
git add event-bus.js
git commit -m "fix(pentest): gate early-exit on spot-check signals — Gap 1 fix landed

The Phase 1.5 spot-check return value was previously discarded by the caller,
so the early-exit decision was blind to high-value attack signals SANJAY
identified during recon (10 signals on the 2026-04-26 politemail-read run).

Changes:
- Capture { misses } from runReconSpotCheck and store on _taskMissedSignals[taskId]
- Replace the endpointCount + reachability-only early-exit block with
  shouldEarlyExit() decision + 4-way branch (CONTINUE / CONTINUE_WITH_HINTS
  / CONTINUE_WITH_HINTS_REACHCHECK / EARLY_EXIT)
- Add one-shot scheme swap (https↔http) for the REACHCHECK branch — closes
  the rare scheme-mismatch case

Pipeline decision is now logged to ACTIVITY-LOG so we can audit later."
```

---

## Task 7: Inject `missedSignals` into pentest specialist prompt

**Files:**
- Modify: `event-bus.js` (`buildPentestSpecialistPrompt` at ~2894 — signature + body)
- Modify: `event-bus.js` callers of `buildPentestSpecialistPrompt` (pass `_taskMissedSignals[taskId]`)

- [ ] **Step 7.1: Find every caller of buildPentestSpecialistPrompt**

Run: `grep -n "buildPentestSpecialistPrompt(" /root/agents/event-bus.js`
Note the line numbers of EACH call site. There's 1 definition (`function buildPentestSpecialistPrompt(...)`) and N callers — you'll update all callers in Step 7.3.

- [ ] **Step 7.2: Add optional `missedSignals` parameter to the builder**

Use `Edit` on the function signature line at ~line 2894. Replace:

`function buildPentestSpecialistPrompt(agentName, taskTitle, taskId, projectId, squad, goalContext, targetUrl, wafStatus, techStack) {`

With:

`function buildPentestSpecialistPrompt(agentName, taskTitle, taskId, projectId, squad, goalContext, targetUrl, wafStatus, techStack, missedSignals = null) {`

Then locate the function body's final `return \`...\`` template literal. Just before that `return` (after the existing variable computation), use `Edit` to insert this block:

```javascript
  // (2026-04-27) Inject Phase 1.5 spot-check missed signals when present.
  // Specialists treat these as HYPOTHESES (not confirmed findings).
  let missedSignalsBlock = ''
  if (Array.isArray(missedSignals) && missedSignals.length > 0) {
    const signalLines = missedSignals.map(s => `- ${String(s).trim()}`).join('\n')
    missedSignalsBlock = `

## RECON SPOT-CHECK MISSED SIGNALS (Phase 1.5 review)
The recon spot-check identified these attack ideas the recon agents missed.
Probe them in addition to your normal mandate. Do NOT treat them as confirmed
findings — they are HYPOTHESES with confidence "medium" until you verify.

${signalLines}
`
  }
```

Then in the existing `return \`...\`` template, append `${missedSignalsBlock}` immediately before the final closing backtick. For example, change:

`Execute now.\``

To:

`Execute now.${missedSignalsBlock}\``

- [ ] **Step 7.3: Update each call site to pass `_taskMissedSignals[taskId]`**

For each line returned by Step 7.1 (other than the definition), use `Edit` to append `, _taskMissedSignals[taskId]` to the argument list inside the call. The default `missedSignals = null` in the signature means callers you forget remain backward-compatible — but you should still update them all.

Example transformation pattern:
- Before: `buildPentestSpecialistPrompt(agentName, taskTitle, taskId, projectId || '', squad, taskGoal || '', targetUrl, wafStatus, techStack)`
- After: `buildPentestSpecialistPrompt(agentName, taskTitle, taskId, projectId || '', squad, taskGoal || '', targetUrl, wafStatus, techStack, _taskMissedSignals[taskId])`

The DHARMA caller in the EARLY_EXIT branch also calls `buildPentestSpecialistPrompt('dharma', ...)` — update that too.

- [ ] **Step 7.4: Run all unit tests**

Run: `cd /root/agents && bun test test/`
Expected: 29/30 files pass (unchanged).

- [ ] **Step 7.5: Sanity-check caller count**

Run: `grep -c "buildPentestSpecialistPrompt(" /root/agents/event-bus.js`
Note this number — it includes the definition + all callers.

Run: `grep -c "buildPentestSpecialistPrompt.*_taskMissedSignals" /root/agents/event-bus.js`
Expected: this number equals (the previous number minus 1 for the definition).

- [ ] **Step 7.6: Commit prompt builder change**

```bash
cd /root/agents
git add event-bus.js
git commit -m "feat(pentest): inject Phase 1.5 missed signals into specialist prompts

Pentest specialist builders (buildPentestSpecialistPrompt) now accept an
optional missedSignals array. When non-empty, the prompt gets a fenced
'RECON SPOT-CHECK MISSED SIGNALS' section listing the LLM-flagged attack
ideas the Haiku recon missed. Specialists treat them as HYPOTHESES.

Pulls from _taskMissedSignals[taskId] populated by the spot-check capture
in Task 6. Closes the 'logged but not propagated' gap from the 2026-04-26
politemail-read run."
```

---

## Task 8: Add framework-verify gates 51 + 52

**Files:**
- Modify: `verify-framework.js` (append two new gate() blocks after GATE-50)

- [ ] **Step 8.1: Find the GATE-50 block end**

Run: `grep -nE "^gate\\('GATE-(50|51)" /root/agents/verify-framework.js`
Expected: GATE-50 exists; GATE-51 does not. Find the closing `})` of the GATE-50 call.

- [ ] **Step 8.2: Append the two new gates**

Use `Edit` to insert (after the GATE-50 closing `})`) the following:

```javascript

gate('GATE-51: no orphan URL-extraction regex copies remain in event-bus.js', () => {
  // The 3 duplicated inline regex sites (formerly at lines 3731, 6066, 7560)
  // must all be replaced by the shared extractTargetUrl helper.
  const src = fs.readFileSync('/root/agents/event-bus.js', 'utf-8')
  // The orphan pattern is the literal `match(/https?:\/\/[^\s` start of the
  // buggy regex. After the fix, no event-bus.js source line should contain it.
  const orphanRe = /match\(\/https\?:\\\/\\\/\[\^\\s/
  if (orphanRe.test(src)) {
    throw new Error('orphan URL regex still inline in event-bus.js — should call extractTargetUrl() instead')
  }
  if (!/require\(['"]\.\/url-extractor['"]\)/.test(src)) {
    throw new Error('event-bus.js does not require ./url-extractor')
  }
  return 'no orphan URL regex sites; extractTargetUrl wired'
})

gate('GATE-52: spot-check misses are captured by caller (not discarded)', () => {
  // The runReconSpotCheck caller must bind the result so misses array reaches
  // the early-exit decision and prompt builder. Bare `await runReconSpotCheck`
  // without binding is the regression we are gating against.
  const src = fs.readFileSync('/root/agents/event-bus.js', 'utf-8')
  const hasCapture = /const\s+\w+\s*=\s*await\s+runReconSpotCheck\(/.test(src)
  const hasMissUse = /_spotCheckMisses|spotResult\.misses|\.misses\s*\)/.test(src)
  if (!hasCapture) {
    throw new Error('runReconSpotCheck call result is not captured (return value discarded)')
  }
  if (!hasMissUse) {
    throw new Error('spot-check misses are captured but never consulted (no .misses or _spotCheckMisses usage downstream)')
  }
  if (!/require\(['"]\.\/early-exit-decision['"]\)/.test(src)) {
    throw new Error('event-bus.js does not require ./early-exit-decision')
  }
  return 'spot-check misses captured + threaded into early-exit decision'
})
```

- [ ] **Step 8.3: Run verify-framework**

Run: `cd /root/agents && node verify-framework.js 2>&1 | tail -10`
Expected last line: `RESULT: 51/52 gates passed` — the 1 pre-existing failing gate from before remains; both new gates 51 + 52 pass.

If GATE-51 or GATE-52 fails, STOP and inspect — likely your earlier wiring missed a site or the require lines didn't land.

- [ ] **Step 8.4: Commit gate additions**

```bash
cd /root/agents
git add verify-framework.js
git commit -m "test(verify-framework): add GATE-51 (no orphan URL regex) + GATE-52 (spot-check captured)

Locks in the Gap 1 + Gap 2 invariants from the 2026-04-27 framework-gaps spec.
GATE-51 fails if any of the 3 inline regex sites reappear in event-bus.js or
if extractTargetUrl is no longer required. GATE-52 fails if runReconSpotCheck
result is discarded again, or if the misses array is captured but unused."
```

---

## Task 9: Save memory entry for the regression class

**Files:**
- Create: `/root/.claude/projects/-root/memory/feedback_pentest_orchestrator_silent_drops.md`
- Modify: `/root/.claude/projects/-root/memory/MEMORY.md` (append index entry)

- [ ] **Step 9.1: Write the memory file**

Use the `Write` tool. Save to `/root/.claude/projects/-root/memory/feedback_pentest_orchestrator_silent_drops.md`:

```markdown
---
name: Pentest orchestrator silent-drop regression class
description: Two pentest pipeline bugs silently swallowed real signals — URL regex returned bare-domain over scheme-prefixed match, and spot-check misses were discarded by the caller. Both fixed 2026-04-27. Pattern: any recon helper that returns structured info MUST be captured by the caller; any first-match-wins regex with overlapping alternatives needs explicit priority ordering.
type: feedback
---

**Two regressions of the same class — both surfaced by the 2026-04-26 ENBD pentest verification:**

1. **URL regex priority bug** at `event-bus.js:3731` (and duplicates at 6066, 7560). The alternation `https?:\/\/...|[\w.-]+\.(com|net|...)` returns the FIRST left-to-right match, so a bare domain in the taskTitle silently beat an https:// URL later in the goal. Then unconditional `http://` prefix downgraded HTTPS-only targets like politemail-read.emiratesnbd.com → "unreachable" → early-exit.

2. **Spot-check feedback loop never wired.** `runReconSpotCheck` returned `{ status: 'ok', misses: [...] }` but the caller at `event-bus.js:4081` awaited bare. The 10 high-value signals SANJAY identified for politemail-read (OData $metadata, sibling subdomain, IIS short-name, etc.) were logged to ACTIVITY-LOG and forgotten — never gated the early-exit decision, never reached specialists' prompts.

**Why:** Both fixes shipped 2026-04-27. New helper modules:
- `agents/url-extractor.js` — single source of truth for goal → targetUrl with explicit priority (scheme first, bare-domain fallback to https://)
- `agents/early-exit-decision.js` — pure shouldEarlyExit() that consults missedSignalsCount

GATE-51 and GATE-52 in verify-framework.js lock in the invariants.

**How to apply (the regression class lesson):**
- When ANY helper function returns structured data (`{misses, status, ...}`), grep the callers — bare `await fn()` without binding is a smell.
- When a regex has alternation between "structured pattern" and "loose fallback", left-to-right scanning means the loose alternative wins if it appears earlier in the input. Use TWO sequential matches with explicit priority instead.
- Activity-log entries are NOT a substitute for explicit data flow. If specialists need a signal, pass it as a parameter; don't rely on grep-scraping.

**Companion to:** `feedback_root_cause_fix.md` (universal fix). Both fixes deduplicated 3 regex sites instead of patching just the failing one.
```

- [ ] **Step 9.2: Append to MEMORY.md index**

Use `Edit` on `/root/.claude/projects/-root/memory/MEMORY.md`. Append after the last entry:

```
- [Pentest Orchestrator Silent-Drop Regression](feedback_pentest_orchestrator_silent_drops.md) — URL regex returned bare-domain over scheme; spot-check return value discarded. Fixed 2026-04-27. Class: silently-dropped structured returns from helpers.
```

- [ ] **Step 9.3: Memory files are not in the agents repo — no commit needed**

Memory files live under `/root/.claude/` which is outside the agents repo working tree. Skip git.

---

## Task 10: Restart event-bus daemon + dispatch live validation

**Files:**
- Operational only — no source files touched.

- [ ] **Step 10.1: Confirm 0 in-flight pentest dispatches before restart**

```bash
python3 -c "
import json
q = json.load(open('/root/intel/dispatch-queue.json'))
processing = [e for e in q if e.get('status') == 'processing' and e.get('squad', '').startswith('pentest')]
print(f'pentest dispatches in processing: {len(processing)}')
for p in processing:
    print(f'  {p[\"taskId\"]} {p.get(\"taskTitle\", \"\")[:60]}')
"
```

Expected: 0. If a pentest is genuinely in progress, WAIT for it to finish — don't restart mid-flight.

- [ ] **Step 10.2: Reload event-bus daemon via PM2**

Run: `pm2 reload event-bus`

If PM2 doesn't manage event-bus, find the daemon PID and SIGTERM it via the supervisor that started it. Per memory `feedback_pkill_safety.md`: NEVER use `pkill -f "bun server.ts"` or generic patterns. Use `pm2 reload` (preferred) or kill the specific PID returned by `pgrep -f "node /root/agents/event-bus.js"`.

After restart, verify daemon back up:
```bash
pgrep -f "node /root/agents/event-bus.js" && echo "alive"
```

- [ ] **Step 10.3: Re-dispatch politemail-read.emiratesnbd.com to validate Gap 1 + Gap 2 fixes**

Use the UI API path. Title MUST contain the bare domain (NOT https://) so we exercise the Gap 2 priority path on the new code.

```bash
TOKEN=$(node -e "process.env.MC_AUTH_SECRET=require('fs').readFileSync('/root/intel/mc-auth-secret','utf-8').trim(); const{signSessionToken}=require('/root/mission-control/lib/session-token'); console.log(signSessionToken(7200))")

curl -sS -X POST -H "Cookie: mc_auth=$TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:3000/api/tasks \
  -d '{"action":"create","task":{"title":"Pentest H1-ENBD VALIDATION — politemail-read.emiratesnbd.com (post 2026-04-27 framework gaps fix)","squad":"pentest","assignee":"KRISHNA","priority":"high","goal":"Re-dispatch validation. Target: https://politemail-read.emiratesnbd.com (HackerOne ENBD private bounty, jaypatel #7, Gold Standard Safe Harbor). Verify: (1) extractTargetUrl returns https:// not http:// despite bare domain in title — Gap 2; (2) spot-check misses gate the early-exit decision, with CONTINUE_WITH_HINTS branching when >=3 signals identified — Gap 1; (3) specialists receive RECON SPOT-CHECK MISSED SIGNALS section in their prompt. H1 rules: X-Hackerone-Research-asm: jaypatel header, bugbountyhackerone-{ts} naming, no DoS, RCE limited to whoami/id/hostname/ls /home."}}'
```

Capture the returned task id from the JSON response. Then execute it:

```bash
NEW_ID=<id from previous response>
curl -sS -X POST -H "Cookie: mc_auth=$TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:3000/api/tasks \
  -d "{\"action\":\"execute\",\"task\":{\"id\":\"$NEW_ID\"}}"
```

- [ ] **Step 10.4: Watch for the right pipeline branch in the activity log**

After ~5 minutes:
```bash
grep "$NEW_ID" /root/intel/ACTIVITY-LOG.jsonl | tail -20
```

Expected to see a `pipeline-decision` entry with `decision: CONTINUE_WITH_HINTS` (not EARLY_EXIT) — confirming Gap 1 fix worked. If the spot-check finds <3 misses on this re-run that's data variance, not regression. The presence of the `pipeline-decision` entry itself is the proof.

Also expect Phase 0's WAF/auth-detect log line to show `https://politemail-read.emiratesnbd.com` (not `http://`) — confirming Gap 2 fix.

- [ ] **Step 10.5: After this run, dispatch a third in-scope ENBD asset for chain-verifier coverage**

The H1 ENBD program scope has many assets; pick one that's a real interactive web app (not a VPN gateway) and is in HTTPS scope. Candidate from prior intel: `finpro.ergodicity.emiratesnbd.com`. Confirm with Jay before dispatching — final selection is his call. Same dispatch shape as Step 10.3.

This step has no code-test gate; the goal is to capture both `chain-verifier verified=true` and `verified=false` paths in production logs for future audit.

---

## Self-review checklist

**1. Spec coverage:** Each spec section maps to a task —
- §3.1 Gap 1 root cause → Task 6 (capture + decision branch) + Task 7 (signal injection)
- §3.2 Gap 2 root cause → Task 1+2 (helper) + Task 5 (3 sites)
- §3.3 Gap 3 → Task 10.5 (third dispatch — operational, not code)
- §4.1-4.4 components → Tasks 1-7
- §4.5 prompt-renderer (actually buildPentestSpecialistPrompt in event-bus.js) → Task 7
- §5.1-5.2 unit tests → Tasks 1+3
- §5.3 verify-framework gates → Task 8
- §5.4 live validation → Task 10
- §6 edge cases → embedded in Task 4 implementation comments + Task 6.3 alt-scheme branch
- §8 rollout plan → Tasks 5/6/7 commits + Task 10
- §9 memory entry → Task 9

**2. Placeholder scan:** No "TBD", no "implement later". Where the plan says "preserve existing block verbatim" (Task 6.3, the EARLY_EXIT body and reachability probe), the executor MUST `sed` the existing file and copy those lines literally — that's a deliberate prescription, not a placeholder.

**3. Type consistency:**
- `extractTargetUrl(dispatch)` signature — Task 1.1 (test), Task 2.1 (impl), Task 5.2/5.3/5.4 (callers): all consistent
- `shouldEarlyExit({endpointCount, targetReachable, missedSignalsCount}) → {decision, reason}` — Task 3.1, Task 4.1, Task 6.3: consistent
- `_taskMissedSignals[taskId]` declared in Task 6.1, set in Task 6.2, read in Task 7.3: consistent
- `EARLY_EXIT_DECISIONS` import alias in Task 6.1, used in Task 6.3: consistent

---

## Execution

**Plan complete and saved to `/root/agents/docs/superpowers/plans/2026-04-27-framework-gaps-fix.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Suited for the 9 code+test tasks (1-9). Task 10 (live re-dispatch) needs human observation so it's not subagent material.

**2. Inline Execution** — Execute tasks in this session via executing-plans skill, batch with checkpoints. Slower but easier to interject if something surprises us.

**Recommendation: Subagent-Driven for tasks 1-9**, then drive Task 10 manually with watching.

**Which approach, Jay?**
