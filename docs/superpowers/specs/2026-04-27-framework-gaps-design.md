# Framework Gaps Fix — Design Spec

**Date:** 2026-04-27
**Author:** Claude (brainstormed with Jay)
**Status:** Approved (Option B — surgical + structural cleanup)
**Trigger:** 2026-04-26 ENBD pentest verification surfaced 3 gaps in `/root/agents/event-bus.js` orchestrator behavior

---

## 1. Problem statement

During the sequential ENBD HackerOne pentest verification (Pentest #1 `msi.emiratesnbd.com` and Pentest #2 `politemail-read.emiratesnbd.com`) on 2026-04-26, three orchestrator-level issues surfaced that prevent the squad from extracting full value from a target:

- **Gap 1 — Spot-check feedback loop is half-wired.** `runReconSpotCheck` produces high-quality "missed signals" (10 in #2: OData `$metadata`, `politemail-write` sibling subdomain, IIS short-name enum, etc.) but the caller discards the return value and the misses never gate the early-exit decision or propagate as structured input to specialists.
- **Gap 2 — URL parsing regex matches bare domains before scheme-prefixed URLs.** A title like `Pentest H1-ENBD — politemail-read.emiratesnbd.com (...)` causes `event-bus.js:3731` to extract the bare domain even when the goal text contains `https://politemail-read.emiratesnbd.com`. The result is `http://` is unconditionally prefixed, breaking HTTPS-only targets.
- **Gap 3 — chain-verifier (Apr-23 hardening) only ran on Pentest #1.** Pentest #2 took the early-exit path (consequence of Gap 2), so Phase 3.6 was never exercised. We need broader real-target coverage of the chain-verifier — but this is a test-coverage problem, not a code defect.

## 2. Goals and non-goals

**Goals**
- Fix the Gap 2 regex bug so `https://`-prefixed targets in goal/description take precedence over bare domains in the title — across all three duplicated sites (event-bus.js:3731, 6066, 7560).
- Wire the spot-check `misses` array into the early-exit decision so a target with 0 crawled endpoints but ≥3 high-value spot-check signals does NOT take the early-exit path.
- Propagate spot-check misses as a discrete, structured input to specialist prompts (not free-text in activity log).
- Refactor the URL extraction and the early-exit decision into testable single-responsibility helpers with unit tests.
- Add a third pentest target run after the fixes ship, using a richer in-scope ENBD asset, to validate chain-verifier on a meatier surface.

**Non-goals**
- Full Phase 1.5 Decision Engine redesign (Option C). Deferred — revisit only if Option B turns out insufficient.
- Touching the cloud / network / code-review squad pipelines. The bug sites and fixes are scoped to the pentest pipeline (which is also where chain-verifier runs).
- Mission-control UI changes. The 87 uncommitted files there are unrelated.

## 3. Root cause analysis

### 3.1 Gap 1 — spot-check return value discarded

**Site:** `event-bus.js:2358-2440` (function definition), `event-bus.js:4081` (caller).

```js
// event-bus.js:4081
await runReconSpotCheck({ taskId, targetUrl, squad, projectId, endpointMapFile })
```

The function returns `{ status: 'ok', misses: [...] }` but the caller awaits without binding. The `misses` array exists only as a single ACTIVITY-LOG entry (free text). The early-exit decision at `event-bus.js:4093` consults only `endpointCount` and `targetReachable`. A target like politemail-read with 0 crawled endpoints but 10 spot-check signals correctly identified by the LLM gets the same treatment as a target with truly zero attack surface.

The function comment ("Feeds back as SANJAY activity so Phase 2 specialists see it in their prompt context") is wishful thinking — specialists pull activity via grep-based fallbacks but only AFTER they spawn, and they don't spawn under early-exit.

### 3.2 Gap 2 — regex alternative ordering bug (CONFIRMED)

**Site:** `event-bus.js:3731-3733` (primary), `event-bus.js:6066-6067` and `event-bus.js:7560-7563` (duplicates).

```js
const targetMatch = (taskTitle + ' ' + description + ' ' + goal)
  .match(/https?:\/\/[^\s'"]+|[\w.-]+\.(?:com|net|org|io|dev|app|xyz|co)/)
const rawTarget = targetMatch ? targetMatch[0].replace(/[,)]/g, '') : 'UNKNOWN_TARGET'
const targetUrl = rawTarget.startsWith('http') ? rawTarget : `http://${rawTarget}`
```

Regex alternation is left-to-right at each position. For input `"Pentest H1-ENBD — politemail-read.emiratesnbd.com (... goal: https://politemail-read.emiratesnbd.com ...)"`:
- At position of bare domain in title, alternative 1 (`https?:\/\/...`) doesn't match (no scheme prefix); alternative 2 matches and wins.
- The `https://` later in goal is never reached.

Then line 3733 prefixes `http://` because rawTarget doesn't start with "http". For HTTPS-only targets (politemail-read returns 302 only on HTTPS) this breaks reachability, contributes to the early-exit signal, and causes Pentest #2's truncated assessment.

The same regex is duplicated three times in event-bus.js — drift risk and triple-fix cost.

### 3.3 Gap 3 — test coverage gap, not a code defect

The chain-verifier (Apr-23 hardening) only runs at Phase 3.6, which only fires when KRISHNA constructs chains in Phase 3.5, which only fires when specialists produced findings. Pentest #2 early-exited before specialists, so chain-verifier never ran. After Gap 1 + Gap 2 are fixed, more targets will reach Phase 3.6 organically; we'll also dispatch a third in-scope ENBD asset to validate on a richer surface and capture both `verified=true` and `verified=false` paths.

## 4. Architecture (Option B)

The fix introduces three small, testable abstractions, replaces three duplicated call sites, and adds one structured input to specialist prompts.

### 4.1 Components

```
agents/
├── url-extractor.js              [NEW] Single source of truth for goal → targetUrl
├── early-exit-decision.js        [NEW] Pure decision function: should we early-exit?
├── event-bus.js                  [MODIFIED] Wire the new helpers; capture spot-check misses
├── prompt-renderer.js            [MODIFIED] Inject MISSED_SIGNALS section when present
└── test/
    ├── url-extractor.test.js              [NEW]
    └── early-exit-decision.test.js        [NEW]
```

### 4.2 `url-extractor.js` (new — Gap 2 fix)

```js
// agents/url-extractor.js
//
// Extract a single target URL from a dispatch (taskTitle + description + goal).
// Replaces three duplicated regex sites in event-bus.js (lines 3731, 6066, 7560).
//
// Priority order:
//   1. Any `https://...` or `http://...` URL anywhere in the combined text wins.
//      If multiple, the first scheme-prefixed match wins.
//   2. If no scheme-prefixed URL is present, fall back to first bare domain match
//      (com|net|org|io|dev|app|xyz|co|ae|sa). Bare matches get `https://` prefix
//      (changed from `http://` — banking targets are HTTPS-only by default).
//   3. If nothing matches, return null. Caller decides whether to abort or use a
//      sentinel — current call sites used 'UNKNOWN_TARGET'; preserve that contract.
//
// Trailing punctuation `,` `)` `.` is stripped from the matched URL.
//
// Why https default for bare domains: HackerOne private programs and modern
// banking infra serve HTTPS only. The 2026-04-26 politemail-read run hit an
// http:// downgrade that triggered a bogus "unreachable" signal. Defaulting
// bare domains to https closes that loophole; if a target is genuinely
// HTTP-only (rare in scope), the caller can pass an explicit http:// in the
// goal and it wins via priority 1.

const SCHEME_RE = /https?:\/\/[^\s'"<>)]+/i
const BARE_RE = /\b[\w.-]+\.(?:com|net|org|io|dev|app|xyz|co|ae|sa)\b/i

function extractTargetUrl(dispatch) {
  const parts = [
    dispatch?.taskTitle || dispatch?.title || '',
    dispatch?.description || '',
    dispatch?.goal || '',
  ]
  const combined = parts.filter(Boolean).join(' ')

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

### 4.3 `early-exit-decision.js` (new — Gap 1 fix)

```js
// agents/early-exit-decision.js
//
// Pure function: given recon outcome signals, decide whether to early-exit
// the pentest pipeline (skip specialist phases) or continue.
//
// Rules (evaluated in order — first matching rule wins):
//   1. If endpointCount > 0 → CONTINUE (target has surface).
//   2. If targetReachable AND missedSignalsCount >= 3 → CONTINUE_WITH_HINTS
//      (spot-check found ≥3 high-value attack ideas — feed them into specialists).
//   3. If targetReachable AND missedSignalsCount < 3 → CONTINUE
//      (SPA / API-only / OAuth-walled apps; let specialists work blind).
//   4. If !targetReachable AND missedSignalsCount >= 3 → CONTINUE_WITH_HINTS_REACHCHECK
//      (probably an HTTP/HTTPS scheme issue — try alt scheme, then continue with hints).
//   5. Otherwise → EARLY_EXIT (truly nothing to test — DHARMA + VYASA only).
//
// Threshold of 3 chosen because the 2026-04-26 politemail-read spot-check
// returned 10 signals; even half of those would warrant continuing. A single
// missed signal is too low-confidence (could be hallucination).

const CONTINUE = 'CONTINUE'
const CONTINUE_WITH_HINTS = 'CONTINUE_WITH_HINTS'
const CONTINUE_WITH_HINTS_REACHCHECK = 'CONTINUE_WITH_HINTS_REACHCHECK'
const EARLY_EXIT = 'EARLY_EXIT'

const MISSED_SIGNAL_THRESHOLD = 3

function shouldEarlyExit({ endpointCount = 0, targetReachable = false, missedSignalsCount = 0 } = {}) {
  if (endpointCount > 0) return { decision: CONTINUE, reason: 'endpoints_found' }
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

### 4.4 `event-bus.js` modifications

Three call sites collapse to `extractTargetUrl(dispatch)`. The early-exit block at lines 4093-4135 is rewritten to:

1. After `runReconSpotCheck`, capture `{ misses }` from the return value.
2. Compute `endpointCount` and `targetReachable` as today.
3. Call `shouldEarlyExit({ endpointCount, targetReachable, missedSignalsCount: misses?.length || 0 })`.
4. Branch on the decision:
   - `EARLY_EXIT` → existing behavior (DHARMA + VYASA + flag dispatch unreachable).
   - `CONTINUE` / `CONTINUE_WITH_HINTS` → fall through to Phase 2 specialist dispatch.
   - `CONTINUE_WITH_HINTS_REACHCHECK` → swap the scheme on the existing `targetUrl` variable (`https://x` → `http://x`, or vice versa), re-run the same reachability curl probe ONCE; if the alt scheme returns a non-`000` HTTP code, mutate `targetUrl` to the alt-scheme value and continue with hints; else fall through to early-exit but log the swap attempt. Do NOT re-extract from the goal — the swap is local to the existing variable.
5. When the decision is `CONTINUE_WITH_HINTS` or `CONTINUE_WITH_HINTS_REACHCHECK`, store `misses` on the task context (e.g. `_taskMissedSignals[taskId] = misses`) so the prompt renderer can pull it.

### 4.5 `prompt-renderer.js` modification

The pentest specialist prompt builders (`buildPentestSpecialistPrompt` and any sibling pentest builders that already accept `goalContext` and `targetUrl`) get an additional optional input: `missedSignals` (array of strings). Cloud / network / code-review builders are NOT touched — those squads have no recon spot-check today. When non-empty, a fenced section is appended to the prompt:

```
## RECON SPOT-CHECK MISSED SIGNALS (Phase 1.5 review)
The recon spot-check identified these attack ideas the recon agents missed.
Probe them in addition to your normal mandate. Do NOT treat them as confirmed
findings — they are HYPOTHESES with confidence "medium" until you verify.

- <signal 1>
- <signal 2>
- ...
```

This keeps the spot-check feedback first-class (specialists see it explicitly), not dependent on activity-log scraping.

## 5. Test strategy

### 5.1 New unit tests

**`test/url-extractor.test.js`** covers:
- title `"https://msi.emiratesnbd.com (...)"` → `https://msi.emiratesnbd.com` (regression case for #1)
- title `"Pentest H1 — politemail-read.emiratesnbd.com (...)"` + goal `"... https://politemail-read.emiratesnbd.com ..."` → `https://politemail-read.emiratesnbd.com` (Gap 2 fix verification)
- bare domain only → `https://example.com` (https default — regression of old http default)
- explicit `http://example.com` in goal → `http://example.com` (preserved)
- empty / missing fields → `null`
- trailing punctuation `https://example.com).` → `https://example.com`
- multiple URLs in text → first scheme-prefixed wins
- HackerOne `wearehackerone.com` email-style strings → not extracted as target (must contain a TLD-only host, not an `@x.y` segment) — covered by SCHEME_RE / BARE_RE not matching email-username portions

**`test/early-exit-decision.test.js`** covers:
- endpoints > 0 → CONTINUE regardless of other inputs
- 0 endpoints, reachable, 0 misses → CONTINUE (current SPA path)
- 0 endpoints, reachable, ≥3 misses → CONTINUE_WITH_HINTS
- 0 endpoints, unreachable, ≥3 misses → CONTINUE_WITH_HINTS_REACHCHECK
- 0 endpoints, unreachable, <3 misses → EARLY_EXIT
- Threshold edge case: exactly 3 misses → CONTINUE_WITH_HINTS
- Threshold edge case: exactly 2 misses, reachable → CONTINUE (no hints)
- Default values when params missing → EARLY_EXIT

### 5.2 Integration test (added to existing harness)

`test/event-bus-spot-check-wiring.test.js` (lightweight): module-level grep tests that confirm event-bus.js
- imports `extractTargetUrl` and `shouldEarlyExit`
- no longer contains the three duplicated regex literal patterns
- the `runReconSpotCheck` caller binds the result to a variable with `const { misses }` or equivalent

### 5.3 Verify-framework gates

Add two gates to `verify-framework.js`:
- **GATE-51:** `extractTargetUrl` is the sole URL extractor (no orphan regex copies remaining)
- **GATE-52:** spot-check misses are captured (regex check that confirms `runReconSpotCheck(...)` is bound, not awaited bare)

### 5.4 Live target validation

After unit + integration tests pass:
- Re-run pentest on `politemail-read.emiratesnbd.com` to verify scheme is now `https://`, reachability succeeds, and (if 0 endpoints) the spot-check's missed signals trigger CONTINUE_WITH_HINTS instead of early-exit.
- Dispatch a third pentest on a richer in-scope ENBD asset (candidate: `finpro.ergodicity.emiratesnbd.com` — appears in prior intel — pending Jay's selection from the program scope) to validate Phase 3.6 chain-verifier on a meatier surface.

## 6. Edge cases

- **Mixed http/https in same goal:** Priority 1 returns the FIRST scheme match. If a goal contains both, the first wins. This matches existing behavior; document it but don't over-engineer.
- **Non-TLD domains (e.g. `localhost:8080`):** Out of scope — bare regex requires a TLD. CTF/lab targets must use explicit `http://localhost:8080` in the goal.
- **Email addresses (`vdp@emiratesnbd.com`):** SCHEME_RE doesn't match; BARE_RE uses `\b` word boundary, so `@emiratesnbd.com` in an email string would still match `emiratesnbd.com` if no scheme-prefixed URL is present. Mitigation: priority 1 ensures any explicit URL wins; priority 2 only fires as a fallback. Real dispatches always include the URL in some form; the chance of email-only goals reaching priority 2 is low. If it becomes an issue, add a `[^@]` lookbehind. Documented; not fixed preemptively.
- **`CONTINUE_WITH_HINTS_REACHCHECK` infinite recursion:** The alt-scheme retry runs ONCE. If the alt scheme also fails, fall through to early-exit. No recursion.
- **Spot-check returns `status: failed` / `parse_failed`:** `misses` is undefined; `missedSignalsCount` defaults to 0; we treat as "no hints" and use the existing reachability-only path.
- **Specialists currently expect free-text activity-log scraping:** The new structured `missedSignals` block is ADDITIVE — the activity-log entry remains. Specialists that were already pulling activity-log get same data. New deployments get a cleaner first-class block.

## 7. Out of scope (deferred)

- **Option C — full Phase 1.5 Decision Engine.** Same outputs, more abstractions, no incremental value over Option B for the current failure modes.
- **Severity tiering of spot-check misses.** The LLM currently returns flat `MISSED:` lines. Adding structured severity would require a prompt change; revisit if signals start being too noisy.
- **Cloud / network / code-review squad equivalents.** They don't have the same recon → spot-check → specialist DAG. Their early-exit paths (if any) are separate.

## 8. Rollout plan

1. Land the two new helper modules + tests in a single commit (`feat(pentest): extract URL parsing + early-exit decision into testable helpers`).
2. Land event-bus.js wiring + prompt-renderer change in a second commit (`feat(pentest): capture spot-check misses, gate early-exit on signal count`).
3. Run the full unit test suite (`bun test test/`). Existing baseline: 27/28 files green, 1 known stale (`network-dispatcher-integration.test.js` chainVerifier-deps assertion — pre-existing, not our regression). After this work: target 29/30 files green (existing baseline + 2 new files). Target gets re-evaluated once the network-dispatcher stale assertion is fixed (out of scope for this spec — tracked separately).
4. Run `verify-framework.js`. Existing baseline: 49/50 gates pass. Adding GATE-51 (no orphan URL regex) and GATE-52 (spot-check misses captured) → target 51/52 (the 1 pre-existing failure remains until fixed independently).
5. Restart event-bus daemon (PM2 reload) — required because it's a long-running process and `freshRequire` only invalidates dispatcher modules, not the orchestrator code itself.
6. Re-dispatch politemail-read.emiratesnbd.com to validate the live fix.
7. Dispatch a third in-scope ENBD asset (Jay picks) to validate chain-verifier on richer surface.
8. Update memory: a new `feedback` entry capturing the spot-check + URL parsing fix, since both were silently swallowing real signals before today.

## 9. Risks

- **PM2 reload risk:** event-bus daemon restart drops in-flight dispatches. Currently 0 in-flight (verified at design time). Schedule restart for a quiet window; if any task is in `processing` when restart fires, it'll resume on retry-loop.
- **Behavioral regression on simple targets:** A simple landing page that passes reachability and has 0 missed signals goes from `EARLY_EXIT` → `CONTINUE`. This is intentional (we'd rather spend $5 on specialist negative results than ship a "0 endpoints found" report when the page IS reachable). The existing reachability check is the gate against burning specialists on truly dead targets.
- **Missed-signals false positives:** LLM occasionally hallucinates. Threshold of 3 mitigates, and signals are framed to specialists as HYPOTHESES requiring verification (not findings).

## 10. References

- 2026-04-26 ENBD pentest verification report: `/root/intel/reports/PENTEST-VERIFICATION-COMPARISON-2026-04-26-ENBD.md`
- Apr-23 chain-verifier hardening: `/root/agents/chain-verifier.js`, `event-bus.js:4601` (Phase 3.6 site)
- Memory entries: `feedback_root_cause_fix.md` (universal fix, no band-aid), `project_framework_hardening_2026_04_23.md`
