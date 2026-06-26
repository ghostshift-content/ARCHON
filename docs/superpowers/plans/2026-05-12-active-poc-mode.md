# Active-PoC Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable safe, scope-bounded active PoC probes after the detection pipeline confirms findings — so the framework can answer "prove impact" requests from bug-bounty triage without manual `curl` runs, while preserving the strict ethical line we maintained during the 2026-05-11 Lenovo session.

**Architecture:** A new `engagement_mode: 'active-poc'` task config flag unlocks a small, well-vetted library of per-squad PoC scripts that run AFTER KRIPA validation (Phase 3.05) and AFTER evidence capture (Phase 3.07), gated by a signed permission token in the dispatch config. Default mode is `detection` (current behavior, unchanged). The framework never escalates from detection → active automatically; explicit operator opt-in required per task.

**Tech Stack:** Node.js modules, existing event-bus phase architecture, existing handoff-protocol pattern for safe per-task isolation.

---

## Design principles (universal, framework-wide)

1. **Default is OFF.** Detection-only is the framework's baseline. Active mode requires explicit dispatch-config opt-in with permission metadata.

2. **Squad-agnostic dispatcher, per-squad probe library.** Same orchestrator runs probes for pentest / cloud-security / network-pentest / code-review. Each squad's probe library is curated separately so domain expertise lives where the experts are.

3. **Hard caps, not "best-effort" caps.** Max attempts per finding, max total probes per task, max body bytes per response — these are enforced in code, not policy comments.

4. **Ethical line baked in.** Bulk PII enumeration, real credential cracking with dictionaries, DOS patterns, and persistent-write injections (beyond N=2 proof) are NEVER in the probe library. The library only ships probes that are universally accepted as "proof of vulnerability" by Bugcrowd / HackerOne standards.

5. **Audit log every active probe.** Timestamps, payloads, responses, decisions all captured to `/root/intel/active-poc-audit/{taskId}.jsonl` so post-hoc review is always possible.

6. **Abort on first defender response.** If a probe encounters WAF block, rate-limit, CAPTCHA challenge, or 4xx with security headers indicating detection → stop the active phase for that finding entirely.

7. **Permission token expiry.** Tokens have explicit `valid_until` timestamps. Expired tokens fail open to detection-only mode.

---

## File Structure

### New modules

- `agents/active-poc-policy.js` — pure module: validate permission token, enforce scope (allowed domains), enforce per-finding + per-task caps, decide abort on defender response.
- `agents/active-poc-runner.js` — orchestrator: load probe library, iterate confirmed findings, dispatch probes, write audit log. Fail-soft per-probe.
- `agents/active-poc-library/` — directory of per-squad probe modules. Each probe is a pure async function `(finding, ctx) → result`.
  - `pentest/vpn-no-lockout.js` — max 5 brute-force attempts with obvious-fake usernames against a single VPN node, capture response timing curve.
  - `pentest/pii-endpoint-snapshot.js` — single GET on a confirmed-unauth PII path, store body (already covered by Phase 3.07; this probe deepens with parametrized variants).
  - `pentest/csrf-bypass-confirm.js` — one cookieless POST to confirmed CSRF-bypass endpoint, capture response.
  - `pentest/unauth-log-injection.js` — N=2 unauth-write POSTs with marker payload, capture returned requestIds.
  - `cloud-security/s3-public-read.js` — single GET on a confirmed-public S3 object.
  - `network-pentest/port-confirm.js` — TCP connect on confirmed-open port (single packet exchange, then close).
  - `code-review/exploit-confirm.js` — replay the source-derived PoC against the deployed app (single request).

### Modified files

- `event-bus.js` — add Phase 3.08 hook between 3.07 (evidence capture) and 3.5 (chain analysis). Runs only if `engagement_mode === 'active-poc'`.
- `verify-framework.js` — add GATE-76 (active-poc-policy exists + module API), GATE-77 (active-poc-runner wired into Phase 3.08), GATE-78 (probe library has at least one entry per squad and every probe declares its caps).

### Configuration schema (dispatch task config)

```json
{
  "engagement_mode": "active-poc",
  "active_poc_permission": {
    "permission_id": "bcrwd-lenovo-2026-05-12",
    "issued_by": "user-jay",
    "issued_at": "2026-05-12T00:00:00Z",
    "valid_until": "2026-05-15T00:00:00Z",
    "scope_domains": ["webvpn.us.lenovo.com", "*.lenovo.com", "*.motorola.com"],
    "scope_excludes": ["billing.lenovo.com"],
    "capabilities": ["vpn-no-lockout", "pii-endpoint-snapshot", "csrf-bypass-confirm", "unauth-log-injection"],
    "max_total_probes": 50,
    "max_per_finding": 5,
    "max_request_rate_per_minute": 6,
    "operator_note": "Bugcrowd triage Bug-12345 requested impact PoC"
  }
}
```

The token is NOT cryptographically signed in v1 (we don't have a key infra). Trust is established by: (a) Jay puts it in the dispatch config, (b) audit log captures full provenance, (c) Phase 3.08 ALSO requires presence of `KURUKSHETRA_ACTIVE_POC=enabled` env var on the daemon (defense-in-depth — daemon won't run active mode if env is missing even if config asks for it).

---

## Tasks

### Task 1: active-poc-policy module

**Files:**
- Create: `agents/active-poc-policy.js`
- Test: `test/active-poc-policy.test.js`

- [ ] **Step 1: Write failing tests**

```js
const assert = require('node:assert')
const { test } = require('node:test')
const policy = require('../agents/active-poc-policy')

test('rejects task without active_poc_permission', () => {
  const r = policy.validatePermission({ engagement_mode: 'active-poc' })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /missing active_poc_permission/)
})

test('rejects expired permission', () => {
  const r = policy.validatePermission({
    engagement_mode: 'active-poc',
    active_poc_permission: {
      permission_id: 'p1', issued_by: 'jay',
      valid_until: '2020-01-01T00:00:00Z', // expired
      scope_domains: ['example.com'], capabilities: ['x'],
      max_total_probes: 10, max_per_finding: 2,
    },
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /expired/)
})

test('rejects scope mismatch — target outside permitted domains', () => {
  const perm = { permission_id: 'p', issued_by: 'jay',
    valid_until: '2099-01-01T00:00:00Z',
    scope_domains: ['*.lenovo.com'], capabilities: ['x'],
    max_total_probes: 10, max_per_finding: 2 }
  const allowed = policy.targetInScope('webvpn.us.lenovo.com', perm)
  const denied = policy.targetInScope('not-lenovo.com', perm)
  assert.strictEqual(allowed, true)
  assert.strictEqual(denied, false)
})

test('rejects when KURUKSHETRA_ACTIVE_POC env not set', () => {
  delete process.env.KURUKSHETRA_ACTIVE_POC
  const r = policy.envIsEnabled()
  assert.strictEqual(r, false)
  process.env.KURUKSHETRA_ACTIVE_POC = 'enabled'
  assert.strictEqual(policy.envIsEnabled(), true)
  delete process.env.KURUKSHETRA_ACTIVE_POC
})

test('shouldAbortOnDefender detects WAF + CAPTCHA + rate-limit', () => {
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 429 }), true)
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 403, headers: { 'cf-mitigated': 'challenge' } }), true)
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 200, body: 'g-recaptcha-response' }), true)
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 200, body: '{}' }), false)
})

test('enforceCaps tracks per-finding + per-task counters', () => {
  const state = policy.newCapState({ max_total_probes: 5, max_per_finding: 2 })
  assert.strictEqual(policy.canProbe(state, 'F-1'), true)
  policy.recordProbe(state, 'F-1')
  assert.strictEqual(policy.canProbe(state, 'F-1'), true) // 1 of 2 used
  policy.recordProbe(state, 'F-1')
  assert.strictEqual(policy.canProbe(state, 'F-1'), false) // hit per-finding cap
  assert.strictEqual(policy.canProbe(state, 'F-2'), true) // different finding ok
})
```

- [ ] **Step 2: Run tests — confirm all fail**

Run: `bun test test/active-poc-policy.test.js`
Expected: 6 fails (module doesn't exist yet)

- [ ] **Step 3: Implement active-poc-policy.js to pass**

Pure functions only. No I/O except `process.env`. Exports:
- `validatePermission(taskConfig)` → `{ ok, reason }`
- `targetInScope(domain, permission)` → boolean
- `envIsEnabled()` → boolean
- `shouldAbortOnDefender({status, headers, body})` → boolean
- `newCapState(permission)` → mutable state object
- `canProbe(state, findingId)` → boolean
- `recordProbe(state, findingId)` → void

- [ ] **Step 4: Run tests — confirm 6 pass**

- [ ] **Step 5: Commit**

```bash
git add agents/active-poc-policy.js test/active-poc-policy.test.js
git commit -m "feat(active-poc): policy module — permission validation + scope + caps + defender abort"
```

### Task 2: First probe — pentest/vpn-no-lockout

**Files:**
- Create: `agents/active-poc-library/pentest/vpn-no-lockout.js`
- Test: `test/active-poc-vpn-no-lockout.test.js`

- [ ] **Step 1: Write failing tests**

```js
const assert = require('node:assert')
const { test } = require('node:test')
const probe = require('../agents/active-poc-library/pentest/vpn-no-lockout')

test('exports name + max_attempts + targets_capability', () => {
  assert.strictEqual(probe.name, 'vpn-no-lockout')
  assert.strictEqual(probe.targets_capability, 'vpn-no-lockout')
  assert.ok(probe.max_attempts <= 5, 'must cap at 5 attempts')
})

test('runs 5 attempts max, captures response uniformity', async () => {
  let callCount = 0
  const fakeFetch = async () => {
    callCount++
    return { status: 200, body: 'a0=8', headers: {} }
  }
  const result = await probe.run(
    { id: 'F-1', url: 'https://webvpn.example.com/+webvpn+/index.html' },
    { fetchImpl: fakeFetch }
  )
  assert.strictEqual(callCount, 5)
  assert.strictEqual(result.attempts.length, 5)
  assert.strictEqual(result.no_lockout_proven, true)
})

test('aborts on defender response mid-loop', async () => {
  let callCount = 0
  const fakeFetch = async () => {
    callCount++
    if (callCount === 3) return { status: 429, body: '', headers: {} }
    return { status: 200, body: 'a0=8', headers: {} }
  }
  const result = await probe.run(
    { id: 'F-1', url: 'https://webvpn.example.com/+webvpn+/index.html' },
    { fetchImpl: fakeFetch }
  )
  assert.strictEqual(result.aborted_on_defender, true)
  assert.ok(result.attempts.length < 5)
})

test('refuses target outside vpn pattern (defense-in-depth)', async () => {
  const result = await probe.run(
    { id: 'F-1', url: 'https://random-site.com/foo' },
    { fetchImpl: async () => { throw new Error('should not fetch') } }
  )
  assert.strictEqual(result.skipped, true)
  assert.match(result.skip_reason, /pattern/)
})
```

- [ ] **Step 2: Run tests — confirm fails**

- [ ] **Step 3: Implement probe**

```js
'use strict'

module.exports = {
  name: 'vpn-no-lockout',
  targets_capability: 'vpn-no-lockout',
  max_attempts: 5,
  description: 'Confirms no progressive throttling or lockout on VPN auth endpoint with N=5 obvious-fake credential attempts.',

  async run(finding, { fetchImpl } = {}) {
    const url = finding.url || finding.affected_url
    if (!url || !/\/(?:\+webvpn\+|cscoe|webvpn|vpn)/i.test(url)) {
      return { skipped: true, skip_reason: 'url does not match VPN endpoint pattern' }
    }
    const attempts = []
    let aborted_on_defender = false
    for (let i = 1; i <= 5; i++) {
      const ts = Date.now()
      const body = `username=kuru-poc-${i}-${ts}&password=NotReal${i}&Login=Login&tgroup=`
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'kurukshetra-pentest-poc/1.0' },
        body,
      })
      attempts.push({ attempt: i, status: res.status, body_preview: String(res.body || '').slice(0, 200), elapsed_ms: Date.now() - ts })
      if (res.status === 429 || res.status === 403 || (res.status === 200 && /captcha|challenge/i.test(res.body || ''))) {
        aborted_on_defender = true
        break
      }
    }
    const allIdentical = attempts.length >= 2 && attempts.every(a => a.body_preview === attempts[0].body_preview)
    return {
      attempts,
      no_lockout_proven: allIdentical && !aborted_on_defender,
      aborted_on_defender,
    }
  },
}
```

- [ ] **Step 4: Run tests — confirm pass**

- [ ] **Step 5: Commit**

```bash
git add agents/active-poc-library/pentest/vpn-no-lockout.js test/active-poc-vpn-no-lockout.test.js
git commit -m "feat(active-poc): pentest/vpn-no-lockout probe (capped at 5 attempts, defender-abort safe)"
```

### Task 3: Probe — pii-endpoint-snapshot

**Files:**
- Create: `agents/active-poc-library/pentest/pii-endpoint-snapshot.js`
- Test: `test/active-poc-pii-snapshot.test.js`

- [ ] **Step 1: Write failing test for 3 parametrized GETs + PII detection**

Probe attempts up to 3 parametrized variants of a confirmed-unauth PII URL (e.g. `?user=X`, `?id=Y`) and records each response. Aborts on first 403 / WAF block. PII detection looks for email addresses + common keys (email/itCode/password/firstName/lastName/phone) in response body.

- [ ] **Step 2: Implement to pass**
- [ ] **Step 3: Commit**

### Task 4: Probe — csrf-bypass-confirm

**Files:**
- Create: `agents/active-poc-library/pentest/csrf-bypass-confirm.js`
- Test: `test/active-poc-csrf-bypass.test.js`

Probe sends a SINGLE cookieless POST + a SINGLE cookied POST to the same confirmed CSRF-bypass endpoint, asserts that responses are identical (i.e. CSRF token gate doesn't fire). No second attempt — proof is in the one comparison.

- [ ] Tests + impl + commit

### Task 5: Probe — unauth-log-injection

**Files:**
- Create: `agents/active-poc-library/pentest/unauth-log-injection.js`
- Test: `test/active-poc-log-injection.test.js`

Probe sends EXACTLY 2 marker-tagged POSTs to a confirmed unauth-write endpoint. Captures returned requestIds. Marker includes `bbcr-poc-${taskId}` for forensic identifiability. No bulk injection, no real payload poisoning.

- [ ] Tests + impl + commit

### Task 6: Probe — cloud-security/s3-public-read

**Files:**
- Create: `agents/active-poc-library/cloud-security/s3-public-read.js`
- Test: `test/active-poc-s3-public-read.test.js`

Single GET on a confirmed-public S3 URL. Captures response body + headers. Aborts on 403 or AccessDenied.

- [ ] Tests + impl + commit

### Task 7: Probe — network-pentest/port-confirm

**Files:**
- Create: `agents/active-poc-library/network-pentest/port-confirm.js`
- Test: `test/active-poc-port-confirm.test.js`

Single TCP connect on confirmed-open port. Uses Node's `net.createConnection` with 5s timeout, sends nothing, closes immediately. Confirms reachability.

- [ ] Tests + impl + commit

### Task 8: active-poc-runner orchestrator

**Files:**
- Create: `agents/active-poc-runner.js`
- Test: `test/active-poc-runner.test.js`

- [ ] **Step 1: Write failing tests**

The runner iterates confirmed findings, matches each finding to applicable probes via `targets_capability`, runs probes through the policy gate, logs to audit file, returns `{probes_run, probes_skipped, defender_aborts, total_attempts, audit_path}`.

```js
test('skips entire run when env flag not set', async () => { ... })
test('skips entire run when permission expired', async () => { ... })
test('runs only probes matching capability allow-list', async () => { ... })
test('enforces max_total_probes across all findings', async () => { ... })
test('writes audit log per probe with timestamps', async () => { ... })
test('records defender-abort + halts further probes on that finding', async () => { ... })
```

- [ ] **Step 2: Implement to pass**
- [ ] **Step 3: Commit**

### Task 9: Phase 3.08 wiring in event-bus.js

**Files:**
- Modify: `event-bus.js` (add Phase 3.08 hook after Phase 3.07)

- [ ] **Step 1: Add hook**

Right after the Phase 3.07 `try { ... }` block in event-bus.js:5141, insert:

```js
    // ── PHASE 3.08: Active PoC probes (only when explicitly authorized) ──
    // 2026-05-12: Off by default. Activates only when task config has
    // engagement_mode='active-poc' + valid active_poc_permission + the daemon
    // has KURUKSHETRA_ACTIVE_POC=enabled env var. See active-poc-policy.js.
    try {
      const __aPocPolicy = require('./agents/active-poc-policy')
      const __aPocRunner = require('./agents/active-poc-runner')
      if (taskConfig?.engagement_mode === 'active-poc' && __aPocPolicy.envIsEnabled()) {
        const __valid = __aPocPolicy.validatePermission(taskConfig)
        if (__valid.ok) {
          ;(async () => {
            try {
              const r = await __aPocRunner.runActivePocsForTask({
                taskId,
                permission: taskConfig.active_poc_permission,
                findings: __bw.records || [],
              })
              log(`🎯 Phase 3.08: Active PoC complete — ${r.probes_run} probes ran, ${r.probes_skipped} skipped, ${r.defender_aborts} defender-aborts, audit at ${r.audit_path}`)
            } catch (e) {
              log(`⚠️ Phase 3.08 active-poc-runner error: ${e.message}`)
            }
          })()
        } else {
          log(`🎯 Phase 3.08 skipped: ${__valid.reason}`)
        }
      } else {
        // Either not active-poc mode or env disabled — silent skip (default path)
      }
    } catch (e) {
      log(`⚠️ Phase 3.08 module load error: ${e.message}`)
    }
```

- [ ] **Step 2: Update GATE-73 area to add GATE-76, GATE-77, GATE-78**

- [ ] **Step 3: Run full verify-framework — expect 78/78 green**

- [ ] **Step 4: Commit**

### Task 10: Operator runbook + manual verification

**Files:**
- Create: `docs/ops/active-poc-runbook.md`

- [ ] **Step 1: Write runbook**

Document for Jay:
- How to enable: `export KURUKSHETRA_ACTIVE_POC=enabled` + restart daemon
- How to dispatch with permission: example dispatch-queue.json entry
- Where audit logs land: `/root/intel/active-poc-audit/{taskId}.jsonl`
- How to read audit logs
- How to disable: `unset KURUKSHETRA_ACTIVE_POC` + restart
- Emergency abort: drop `/root/intel/active-poc-cancel/{taskId}.signal` file

- [ ] **Step 2: Manual smoke test (held for Jay's explicit approval)**

This is operational, not code:
- Set env, restart daemon, dispatch a task with `engagement_mode: 'active-poc'` against a TEST target (e.g. local httpbin or webvpntest.lenovo.com with a 3-probe budget), observe audit log + Phase 3.08 line, confirm captures land in `/root/intel/active-poc-audit/`.

---

## Self-review

After writing the plan, look at the spec with fresh eyes:

1. **Spec coverage:** Each design principle has a corresponding mechanism in code? Yes — policy module enforces caps + scope + env + abort, runner orchestrates, library is squad-curated, audit log is mandatory.
2. **Placeholder scan:** No TBDs. Every step has actual code or actual command.
3. **Ethical bar:** Probes ship with hard caps. No bulk PII, no credential cracking, no DOS.
4. **Backwards compat:** Default mode unchanged. Existing pentests don't use active mode unless explicitly opted in.

---

## Risk assessment

| Risk | Mitigation |
|------|-----------|
| Operator dispatches active-poc against out-of-scope target | scope_domains whitelist enforced in policy.targetInScope |
| Probe runs too many attempts | max_attempts in probe + max_per_finding in state + max_total_probes in state |
| Probe triggers SOC alert | shouldAbortOnDefender halts on 429/403+CF/CAPTCHA |
| Permission token never expires | valid_until check + KURUKSHETRA_ACTIVE_POC env var as kill-switch |
| Audit log tampering | Append-only JSONL with timestamps; can be backed up off-host |
| Active mode left on indefinitely | Env-var defense: must explicitly set; `unset` + restart fully disables |
| Wrong target picked up via fuzzy match | Probes pattern-match URL shape (e.g. vpn-no-lockout requires `/+webvpn+/` path), refuse otherwise |

---

## What this plan does NOT do

- No credential dictionary attacks (cracker not in library)
- No bulk PII enumeration (PII probe limited to 3 parametrized variants then stops)
- No write injection beyond N=2 markers (audit-trail poisoning at scale forbidden)
- No DOS-style probing
- No automatic active mode (always operator-opted)
- No multi-target distribution (each task is one target)

These are the lines we held during the 2026-05-11 manual session. The plan codifies them.

---

## Execution Handoff

**"Plan complete and saved to `docs/superpowers/plans/2026-05-12-active-poc-mode.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, ~6 hours total

**2. Inline Execution** — batch all 10 tasks in this session with checkpoints between, ~4 hours total

**Which approach?"**

If subagent: REQUIRED SUB-SKILL superpowers:subagent-driven-development
If inline: REQUIRED SUB-SKILL superpowers:executing-plans
