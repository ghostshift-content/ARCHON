# Universal Scope Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the scope-drift bug class across all kurukshetra squads by catching out-of-scope work at the earliest possible point (Phase 0.5) rather than at Phase 3.06 post-finding.

**Architecture:** Two new helper modules + 2 GATE additions + 1 squad-policy contract extension. Phase 0.5 wire adds a redirect-walker that follows 1-2 hops from the dispatch target to detect drift before specialists fire. Wildcard-ban GATE prevents lazy scope configs in security squads. All modifications are surgical (no breaking changes to existing wires).

**Tech Stack:** Node.js (no new deps), bun test runner, existing event-bus.js + scope-validator.js + squad-policy adapters.

**Why this plan exists:** 2026-05-16 passport.lenovo.com pentest drifted from passport.lenovo.com → ipgpassport.lenovo.com via redirect. My scope config used `*.lenovo.com` wildcard, which masked the drift. All 15 findings landed on ipgpassport (technically OOS by Bugcrowd's explicit-hostname rules). Cost: $44.83 of work technically requires "infrastructure dependency" framing to be Bugcrowd-submittable.

Same bug class hit yesterday on Q#8 Motorola (paymentuxe-*.cloud.motorola.net). Two same-class incidents in 48 hours = systemic problem.

---

## File Structure

**New files:**
- `agents/scope-redirect-walker.js` — Universal pre-dispatch redirect-chain checker. Pure async function: takes target URL + scope config, performs curl-follow (1-2 hops), returns `{ allowed, blocked_hops, infra_dep_candidates }`. No global state.
- `test/scope-redirect-walker.test.js` — 10 cases covering happy path, single redirect, double redirect, redirect to OOS, redirect to documented infra-dep, timeout, network failure, https→http downgrade, circular redirect, missing target.
- `test/gate-86-wildcard-scope-ban.test.js` — Regression test: scope config with `*.<domain>` for security squads triggers warning unless `allow_wildcards: true` is set.

**Modified files:**
- `event-bus.js` — Insert Phase 0.45 wire (between Phase 0.0 scope-prevalidator and Phase 0.5 WAF detect). Reads scope-{taskId}.json, calls scope-redirect-walker, logs result. On block: same fail-fast path as Phase 0.0 blocked (set dispatch status='failed').
- `agents/scope-prevalidator.js` — Add wildcard-ban check for security squads (pentest, cloud-security, network-pentest). Reject wildcards UNLESS scope config sets `allow_wildcards: true` opt-in.
- `verify-framework.js` — Add GATE-86 (scope-redirect-walker wired into Phase 0.45) and GATE-87 (wildcard-ban for security squads with opt-in flag).
- `/root/intel/CLAUDE.md` — Document new scope-config schema fields: `allow_wildcards`, `redirect_check.enabled`, `redirect_check.max_hops`.

**Not modified (intentionally):**
- `agents/scope-validator.js` — Post-finding validator stays as-is. Pre-dispatch + redirect-walker + post-finding form a 3-layer defense.
- `agents/squad-policy/*.js` — Squad adapters stay as-is.

---

## Task 1: scope-redirect-walker.js — Universal Pre-Dispatch Redirect Check

**Files:**
- Create: `agents/scope-redirect-walker.js`
- Test: `test/scope-redirect-walker.test.js`

- [ ] **Step 1: Write failing test (TDD)**

```js
// test/scope-redirect-walker.test.js
'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const walker = require('../agents/scope-redirect-walker')

test('happy path: target stays on in-scope host', async () => {
  // Mock curl: returns 200 OK with no redirect.
  // (For tests, walker accepts an injected `fetchImpl` for determinism.)
  const fetchImpl = async () => ({ status: 200, headers: {} })
  const scope = { in_scope: ['passport.lenovo.com'], out_of_scope: [], infra_dependencies: {} }
  const result = await walker.checkRedirects('https://passport.lenovo.com', scope, { fetchImpl, maxHops: 2 })
  assert.strictEqual(result.allowed, true)
  assert.deepStrictEqual(result.blocked_hops, [])
})

test('single redirect to OOS host → blocked', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://passport.lenovo.com/') return { status: 302, headers: { location: 'https://ipgpassport.lenovo.com/cas/login' } }
    return { status: 200, headers: {} }
  }
  const scope = { in_scope: ['passport.lenovo.com'], out_of_scope: ['ipgpassport.lenovo.com'], infra_dependencies: {} }
  const result = await walker.checkRedirects('https://passport.lenovo.com', scope, { fetchImpl, maxHops: 2 })
  assert.strictEqual(result.allowed, false)
  assert.ok(result.blocked_hops.length > 0)
  assert.match(result.blocked_hops[0].url, /ipgpassport/)
})

test('redirect to documented infra-dep host → allowed with note', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://passport.lenovo.com/') return { status: 302, headers: { location: 'https://ipgpassport.lenovo.com/' } }
    return { status: 200, headers: {} }
  }
  const scope = {
    in_scope: ['passport.lenovo.com'],
    out_of_scope: [],
    infra_dependencies: { 'ipgpassport.lenovo.com': ['passport.lenovo.com'] },
  }
  const result = await walker.checkRedirects('https://passport.lenovo.com', scope, { fetchImpl, maxHops: 2 })
  assert.strictEqual(result.allowed, true, 'infra-dep host should be allowed')
  assert.ok(result.infra_dep_candidates.includes('ipgpassport.lenovo.com'))
})

test('double redirect chain stops at maxHops', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('hop1')) return { status: 302, headers: { location: 'https://hop2.evil.com/' } }
    if (url.includes('hop2')) return { status: 302, headers: { location: 'https://hop3.evil.com/' } }
    return { status: 200, headers: {} }
  }
  const scope = { in_scope: ['hop1.example.com'], out_of_scope: [], infra_dependencies: {} }
  const result = await walker.checkRedirects('https://hop1.example.com', scope, { fetchImpl, maxHops: 2 })
  assert.ok(result.blocked_hops.length > 0)
})

test('timeout returns warned status, not blocked', async () => {
  // Pure-fn behavior: if fetchImpl rejects with timeout, walker returns
  // { allowed: true, warning: 'redirect check timed out' } — fail-open by design.
  const fetchImpl = async () => { throw new Error('timeout') }
  const scope = { in_scope: ['x.example.com'] }
  const result = await walker.checkRedirects('https://x.example.com', scope, { fetchImpl, maxHops: 2 })
  assert.strictEqual(result.allowed, true)
  assert.match(result.warning || '', /timed out|error/i)
})

test('https → http downgrade detected and logged', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://')) return { status: 302, headers: { location: 'http://insecure.example.com/' } }
    return { status: 200, headers: {} }
  }
  const scope = { in_scope: ['secure.example.com', 'insecure.example.com'] }
  const result = await walker.checkRedirects('https://secure.example.com', scope, { fetchImpl, maxHops: 2 })
  assert.strictEqual(result.allowed, true) // both hosts in scope
  assert.match(result.warning || '', /downgrade/i)
})

test('circular redirect halts cleanly', async () => {
  const fetchImpl = async () => ({ status: 302, headers: { location: 'https://a.example.com/' } })
  const scope = { in_scope: ['a.example.com'] }
  const result = await walker.checkRedirects('https://a.example.com', scope, { fetchImpl, maxHops: 2 })
  assert.ok(result, 'must return without infinite loop')
})

test('missing target returns null-equivalent', async () => {
  const result = await walker.checkRedirects(null, {}, { fetchImpl: async () => ({}) })
  assert.strictEqual(result.allowed, false)
  assert.match(result.reason || '', /no target/i)
})

test('exports the public API', () => {
  assert.strictEqual(typeof walker.checkRedirects, 'function')
})
```

- [ ] **Step 2: Run test to confirm fail**

```bash
cd /root/agents && bun test test/scope-redirect-walker.test.js 2>&1 | tail -10
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement scope-redirect-walker.js**

Build the module: `checkRedirects(targetUrl, scopeConfig, { fetchImpl, maxHops })`. Uses node's fetch (default) or injected fetchImpl for testing. Follow redirects manually (so each hop can be scope-checked individually). Track blocked_hops + infra_dep_candidates + warnings. Reuse `agents/scope-validator.js`'s hostname matching for consistency.

Time: ~3 hours.

- [ ] **Step 4: Run tests — all 9 pass**

- [ ] **Step 5: Commit**

```bash
git add agents/scope-redirect-walker.js test/scope-redirect-walker.test.js
git commit -m "feat: scope-redirect-walker — pre-dispatch 2-hop redirect check (universal)"
```

---

## Task 2: Wire Phase 0.45 redirect check into event-bus.js + GATE-86

**Files:**
- Modify: `event-bus.js` (insert Phase 0.45 between Phase 0.0 and Phase 0.5)
- Create: `test/gate-86-redirect-walker.test.js`
- Modify: `verify-framework.js` (add GATE-86)

- [ ] **Step 1: Write GATE-86 test (failing first)**

GATE-86 test: scans event-bus.js for the Phase 0.45 marker + `require('./agents/scope-redirect-walker')` + `checkRedirects(` call + fail-soft try/catch wrap.

- [ ] **Step 2: Run GATE-86 — expect fail**

- [ ] **Step 3: Insert Phase 0.45 wire**

Add the wire block AFTER Phase 0.0 scope-prevalidator (line ~8174) and BEFORE the runningTasks.has(taskId) check. Block calls `scope-redirect-walker.checkRedirects(targetUrl, scopeConfig, { maxHops: 2 })`. On blocked result: update dispatch-queue entry to status='failed' + return.

- [ ] **Step 4: Run GATE-86 + full suite — all pass**

- [ ] **Step 5: Commit**

---

## Task 3: Wildcard-Scope Ban for Security Squads + GATE-87

**Files:**
- Modify: `agents/scope-prevalidator.js`
- Create: `test/gate-87-wildcard-scope-ban.test.js`
- Modify: `verify-framework.js` (add GATE-87)

- [ ] **Step 1: Failing test — wildcard scope without opt-in should fail dispatch on security squad**

```js
test('GATE-87: wildcard scope on security squad without allow_wildcards opt-in → blocked', () => {
  const sp = require('../agents/scope-prevalidator')
  const pentest = require('../agents/squad-policy/pentest')
  const scope = { in_scope: ['*.lenovo.com'] } // wildcard, no opt-in
  const dispatch = { squad: 'pentest', goal: 'Pentest https://api.lenovo.com' }
  const r = sp.validateDispatch(dispatch, pentest, scope)
  assert.strictEqual(r.status, 'blocked')
  assert.match(r.reason, /wildcard.*opt-in|allow_wildcards/i)
})

test('wildcard scope WITH allow_wildcards: true → allowed', () => {
  const sp = require('../agents/scope-prevalidator')
  const pentest = require('../agents/squad-policy/pentest')
  const scope = { in_scope: ['*.lenovo.com'], allow_wildcards: true }
  const dispatch = { squad: 'pentest', goal: 'Pentest https://api.lenovo.com' }
  const r = sp.validateDispatch(dispatch, pentest, scope)
  assert.strictEqual(r.status, 'allowed')
})

test('non-security squad (stocks) wildcard always allowed', () => {
  const sp = require('../agents/scope-prevalidator')
  const stocks = require('../agents/squad-policy/stocks')
  const scope = { in_scope: ['*'] } // wildcard, no opt-in needed for stocks
  const dispatch = { squad: 'stocks', ticker: 'RELIANCE' }
  const r = sp.validateDispatch(dispatch, stocks, scope)
  assert.strictEqual(r.status, 'allowed')
})
```

- [ ] **Step 2: Implement wildcard-ban check in scope-prevalidator.js**

At the start of `validateDispatch`, after scope-config null check: if `squadPolicy.squad` is in `['pentest', 'cloud-security', 'network-pentest']` AND `scope.in_scope` contains any pattern starting with `*.` AND `scope.allow_wildcards !== true` → return blocked with explanatory reason.

- [ ] **Step 3: Run tests + GATE-87 — all pass**

- [ ] **Step 4: Commit**

---

## Task 4: Update /root/intel/CLAUDE.md with new scope-config schema

- [ ] Document the new optional fields:
  - `allow_wildcards: boolean` — opt-in for wildcard hostnames in security squads
  - `redirect_check.enabled: boolean` (default true) — enable Phase 0.45 check
  - `redirect_check.max_hops: number` (default 2) — how far to follow redirects

- [ ] Add example: Lenovo Bugcrowd scope (already in `/root/intel/lenovo-bugcrowd-scope.json`) — explicit hostnames + infra_dependencies map.

- [ ] Commit `/root/intel/CLAUDE.md` (not in git repo — just save to disk).

---

## Task 5: Live smoke test — re-dispatch passport.lenovo with strict scope

**OPERATIONAL ONLY — no commit. Requires Jay's explicit approval (real-money dispatch).**

- [ ] Use `/root/intel/lenovo-bugcrowd-scope.json` as the scope config for new dispatch
- [ ] Phase 0.0 fires `allowed` (passport.lenovo.com in explicit scope)
- [ ] Phase 0.45 fires: target redirects to ipgpassport.lenovo.com → checks infra_dependencies → `allowed` with note
- [ ] Run full pentest — specialists now have correct scope context
- [ ] Compare findings against 2026-05-15 run

---

## Self-Review

**1. Spec coverage:**
- ✅ Phase 0.5 redirect-chain check → Task 1+2
- ✅ Wildcard ban for security squads → Task 3
- ✅ Schema documentation → Task 4
- 🟡 Per-HTTP-call scope check in specialists → DEFERRED (need separate plan, larger scope)
- 🟡 Bugcrowd-scope-text parser UI → DEFERRED (UI work, separate sprint)

**2. Placeholder scan:** None.

**3. Type consistency:** `scope.in_scope`, `scope.out_of_scope`, `scope.infra_dependencies`, `scope.allow_wildcards`, `scope.redirect_check.{enabled, max_hops}` all consistent across modules.

**4. Total effort estimate:** 8-10 hours (Tasks 1+2+3+4). Task 5 is operational verification, not code.

---

**Plan complete. Execution approach when approved:**

**Option A: Subagent-driven** — fresh subagent per task, spec+quality review between, ~10 hrs autonomous
**Option B: Inline execution** — execute all tasks in session, batch checkpoints

Author note: Tasks 1-3 are independent and small enough that subagent-driven works well. Task 4 is docs-only.
