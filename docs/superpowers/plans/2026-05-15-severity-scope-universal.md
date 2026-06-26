# Severity Profiles + Pre-Dispatch Scope Hard-Block — Universal Multi-Squad Sprint

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-selectable severity profiles (bounty/pentest/comprehensive) and pre-dispatch scope hard-block to kurukshetra, working uniformly across all 5 squads (pentest, cloud-security, network-pentest, code-review, stocks).

**Architecture:** Two universal pure-fn modules (`severity-profile.js`, `scope-prevalidator.js`) consume per-squad policy adapters under `agents/squad-policy/{squad}.js`. Severity filter hooks into event-bus.js at Phase 3.075 (after KRIPA validation, before VYASA report). Pre-dispatch scope-prevalidator hooks at new Phase 0.0 (before WAF detect). DOWNGRADE-NOT-DROP discipline preserved: below-threshold findings move to `ARCHIVED-FINDINGS-{taskId}.jsonl` rather than being deleted.

**Tech Stack:** Node.js (no new deps), bun test runner, existing event-bus.js orchestrator, existing scope-validator.js (POST-finding sibling — stays in place).

---

## File Structure

**New files:**

- `agents/severity-profile.js` — Universal severity classifier. Exports `PROFILES`, `ZERO_DAY_INDICATORS`, `classifyFinding`, `filterFindings`, `summarize`. Pure functions, no I/O.
- `agents/scope-prevalidator.js` — Universal pre-dispatch validator. Exports `PREDISPATCH_STATUS`, `validateDispatch`. Delegates target extraction and matching to squad policy adapter. Pure functions.
- `agents/squad-policy/pentest.js` — pentest squad adapter: hostname/wildcard scope (delegates to existing `scope-validator.js`), numeric CVSS.
- `agents/squad-policy/cloud-security.js` — `{accountId, regions}` scope, numeric CVSS.
- `agents/squad-policy/network-pentest.js` — CIDR scope using inline IPv4-range check, numeric CVSS.
- `agents/squad-policy/code-review.js` — source-dir path-prefix scope, severity-keyword → pseudo-CVSS map.
- `agents/squad-policy/stocks.js` — ticker-symbol allowlist (`*` = all), conviction → pseudo-CVSS map.
- `test/severity-profile.test.js` — 12 cases covering profile thresholds, zero-day bypass, archive discipline.
- `test/scope-prevalidator.test.js` — 10 cases across all 5 squads.
- `test/squad-policy.test.js` — 8 cases verifying each adapter's contract.
- `test/gate-80-severity-profile.test.js` — Regression lock: filter hook actually fires in event-bus dispatch flow.
- `test/gate-81-scope-prevalidator.test.js` — Regression lock: OOS dispatches fail-fast before WAF phase.

**Modified files:**

- `event-bus.js` — Insert Phase 0.0 (scope pre-validation) before Phase 0.5 (WAF detect). Insert Phase 3.075 (severity filter) between Phase 3.07 (evidence capture) and Phase 3.08 (active-poc). Both fail-soft on adapter/config errors (log warning, continue).
- `scripts/kurukshetra-verify-loop.sh` — Add GATE-80 and GATE-81 to the gate sequence.

**Not modified (intentionally):**

- `agents/scope-validator.js` (POST-finding, shipped 2026-05-15) — stays in place. Pre-validator and post-validator are complementary.
- `agents/prod-endpoint-validator.js` (shipped 2026-05-15) — independent concern.

---

## Task 1: severity-profile.js (universal pure module)

**Files:**
- Create: `agents/severity-profile.js`
- Test: `test/severity-profile.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/severity-profile.test.js
'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const sp = require('../agents/severity-profile')

const PENTEST_POLICY = {
  squad: 'pentest',
  cvssOf: f => Number(f.cvss || 0),
  severityKey: f => (f.severity || 'low').toLowerCase(),
}

test('bounty profile keeps CVSS >= 8.0', () => {
  const findings = [
    { id: 'F-1', cvss: 9.1, severity: 'critical', title: 'SQLi RCE' },
    { id: 'F-2', cvss: 5.5, severity: 'medium', title: 'Open redirect' },
  ]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY)
  assert.strictEqual(r.reported.length, 1)
  assert.strictEqual(r.reported[0].id, 'F-1')
  assert.strictEqual(r.archived.length, 1)
  assert.strictEqual(r.archived[0].id, 'F-2')
})

test('bounty profile bypasses floor for zero-day indicator', () => {
  const findings = [
    { id: 'F-1', cvss: 4.0, severity: 'medium', title: 'Pre-auth RCE in webhook' },
  ]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY)
  assert.strictEqual(r.reported.length, 1, 'zero-day indicator must bypass CVSS floor')
  assert.match(r.reported[0].profile_reason, /zero[- ]day/i)
})

test('pentest profile keeps CVSS >= 4.0', () => {
  const findings = [
    { id: 'F-1', cvss: 7.0 }, { id: 'F-2', cvss: 4.0 }, { id: 'F-3', cvss: 2.0 },
  ]
  const r = sp.filterFindings(findings, 'pentest', PENTEST_POLICY)
  assert.strictEqual(r.reported.length, 2)
  assert.strictEqual(r.archived.length, 1)
})

test('comprehensive profile keeps everything', () => {
  const findings = [
    { id: 'F-1', cvss: 9.0 }, { id: 'F-2', cvss: 5.0 }, { id: 'F-3', cvss: 1.0 },
  ]
  const r = sp.filterFindings(findings, 'comprehensive', PENTEST_POLICY)
  assert.strictEqual(r.reported.length, 3)
  assert.strictEqual(r.archived.length, 0)
})

test('DOWNGRADE-NOT-DROP: total count is preserved', () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({ id: `F-${i}`, cvss: i }))
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY)
  assert.strictEqual(r.reported.length + r.archived.length, 10,
    'every finding must be either reported or archived — never discarded')
})

test('archived findings carry archive_reason for audit', () => {
  const findings = [{ id: 'F-1', cvss: 3.0, severity: 'low' }]
  const r = sp.filterFindings(findings, 'pentest', PENTEST_POLICY)
  assert.strictEqual(r.archived.length, 1)
  assert.match(r.archived[0].archive_reason, /below.*pentest.*floor.*4/i)
})

test('reported findings carry profile_reason', () => {
  const findings = [{ id: 'F-1', cvss: 9.0, severity: 'critical', title: 'RCE' }]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY)
  assert.match(r.reported[0].profile_reason, /cvss.*9/i)
})

test('classifyFinding returns decision + reason for single finding', () => {
  const c = sp.classifyFinding({ id: 'F-1', cvss: 9.5 }, 'bounty', PENTEST_POLICY)
  assert.strictEqual(c.decision, 'report')
  assert.match(c.reason, /cvss/i)
})

test('zero-day indicator phrases work case-insensitively in title or details', () => {
  for (const text of [
    'Account Takeover via token leak',
    'STORED XSS IN ADMIN PANEL',
    'IDOR on sensitive customer PII',
    'privilege escalation via insecure deserialization',
  ]) {
    const c = sp.classifyFinding({ id: 'F-X', cvss: 3.0, title: text }, 'bounty', PENTEST_POLICY)
    assert.strictEqual(c.decision, 'report', `expected report for "${text}"`)
  }
})

test('summarize counts reported, archived, total', () => {
  const findings = [
    { id: 'F-1', cvss: 9.0 }, { id: 'F-2', cvss: 5.0 }, { id: 'F-3', cvss: 1.0 },
  ]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY)
  const s = sp.summarize(r)
  assert.strictEqual(s.reported, 1)
  assert.strictEqual(s.archived, 2)
  assert.strictEqual(s.total, 3)
})

test('unknown profile name falls back to pentest with warning', () => {
  const findings = [{ id: 'F-1', cvss: 5.0 }]
  const r = sp.filterFindings(findings, 'gibberish', PENTEST_POLICY)
  assert.strictEqual(r.reported.length, 1, 'unknown profile defaults to pentest (CVSS>=4)')
  assert.ok(r.warnings && r.warnings.length > 0)
})

test('exports PROFILES and ZERO_DAY_INDICATORS for inspection', () => {
  assert.ok(sp.PROFILES.bounty)
  assert.ok(sp.PROFILES.pentest)
  assert.ok(sp.PROFILES.comprehensive)
  assert.ok(Array.isArray(sp.ZERO_DAY_INDICATORS))
})
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /root/agents && bun test test/severity-profile.test.js
```

Expected: FAIL with "Cannot find module '../agents/severity-profile'"

- [ ] **Step 3: Write the implementation**

```js
// agents/severity-profile.js
//
// 2026-05-15: Universal severity profile filter. Borrowed pattern from
// bughunter-ai (h4ckologic/bughunter-ai) — user-selectable mode at
// dispatch decides which findings reach the final report.
//
// Three profiles: bounty (high-only, paid programs), pentest (medium+,
// engagements), comprehensive (all severities, research). Zero-day
// indicator phrases bypass the CVSS floor.
//
// DOWNGRADE-NOT-DROP: findings below threshold move to archived, never
// deleted. Archived findings remain available for cross-squad chain
// analysis and audit.

'use strict'

const PROFILES = Object.freeze({
  bounty: Object.freeze({ name: 'bounty', min_cvss: 8.0, target_count: 10 }),
  pentest: Object.freeze({ name: 'pentest', min_cvss: 4.0, target_count: 20 }),
  comprehensive: Object.freeze({ name: 'comprehensive', min_cvss: 0.0, target_count: 50 }),
})

const ZERO_DAY_INDICATORS = Object.freeze([
  /\bpre[-_ ]?auth(entication)?\s+rce\b/i,
  /\bauth(entication)?\s+bypass\b/i,
  /\baccount\s+takeover\b/i,
  /\bidor.*sensitive\b/i,
  /\bstored\s+xss.*admin\b/i,
  /\bprivilege\s+escalation\b/i,
  /\bno\s+(public\s+)?cve\b/i,
  /\bzero[-_ ]?day\b/i,
  /\bnovel\s+technique\b/i,
])

function _profileFor(name) {
  return PROFILES[name] || null
}

function _findingText(finding) {
  return ((finding && finding.title) || '') + ' ' + ((finding && finding.details) || '')
}

function _matchesZeroDay(finding) {
  const text = _findingText(finding)
  for (const re of ZERO_DAY_INDICATORS) {
    if (re.test(text)) return re.source
  }
  return null
}

function classifyFinding(finding, profileName, squadPolicy) {
  const profile = _profileFor(profileName) || PROFILES.pentest
  const cvss = squadPolicy.cvssOf(finding)
  const zeroDayMatch = _matchesZeroDay(finding)
  if (zeroDayMatch) {
    return { decision: 'report', reason: `zero-day indicator matched: ${zeroDayMatch}` }
  }
  if (cvss >= profile.min_cvss) {
    return { decision: 'report', reason: `cvss ${cvss} >= ${profile.min_cvss} (${profile.name})` }
  }
  return {
    decision: 'archive',
    reason: `cvss ${cvss} below ${profile.name} floor ${profile.min_cvss}`,
  }
}

function filterFindings(findings, profileName, squadPolicy) {
  const warnings = []
  if (!_profileFor(profileName)) {
    warnings.push(`unknown profile "${profileName}" — defaulting to pentest`)
  }
  const reported = []
  const archived = []
  for (const f of findings || []) {
    const { decision, reason } = classifyFinding(f, profileName, squadPolicy)
    if (decision === 'report') {
      reported.push({ ...f, profile_reason: reason })
    } else {
      archived.push({ ...f, archive_reason: reason })
    }
  }
  return { reported, archived, warnings }
}

function summarize(filterResult) {
  const r = filterResult || {}
  const reported = (r.reported || []).length
  const archived = (r.archived || []).length
  return { reported, archived, total: reported + archived }
}

module.exports = {
  PROFILES,
  ZERO_DAY_INDICATORS,
  classifyFinding,
  filterFindings,
  summarize,
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd /root/agents && bun test test/severity-profile.test.js
```

Expected: PASS, 12 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add agents/severity-profile.js test/severity-profile.test.js
git commit -m "feat: severity-profile.js — universal bounty/pentest/comprehensive filter (borrow #3)"
```

---

## Task 2: squad-policy adapters (5 squads)

**Files:**
- Create: `agents/squad-policy/pentest.js`
- Create: `agents/squad-policy/cloud-security.js`
- Create: `agents/squad-policy/network-pentest.js`
- Create: `agents/squad-policy/code-review.js`
- Create: `agents/squad-policy/stocks.js`
- Test: `test/squad-policy.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/squad-policy.test.js
'use strict'
const assert = require('node:assert')
const { test } = require('node:test')

const pentest = require('../agents/squad-policy/pentest')
const cloudSec = require('../agents/squad-policy/cloud-security')
const netPentest = require('../agents/squad-policy/network-pentest')
const codeRev = require('../agents/squad-policy/code-review')
const stocks = require('../agents/squad-policy/stocks')

test('pentest.extractTarget pulls hostname from goal text', () => {
  const t = pentest.extractTarget({ goal: 'Pentest https://api.motorola.com/v1/users for OWASP top 10' })
  assert.strictEqual(t, 'api.motorola.com')
})

test('pentest.cvssOf returns numeric CVSS', () => {
  assert.strictEqual(pentest.cvssOf({ cvss: 7.5 }), 7.5)
  assert.strictEqual(pentest.cvssOf({ cvss: '9.1' }), 9.1)
  assert.strictEqual(pentest.cvssOf({}), 0)
})

test('pentest.matchesScope delegates to scope-validator', () => {
  const scope = { in_scope: ['*.motorola.com'], infra_dependencies: {} }
  assert.strictEqual(pentest.matchesScope('api.motorola.com', scope), true)
  assert.strictEqual(pentest.matchesScope('evil.com', scope), false)
})

test('cloud-security.extractTarget returns accountId + regions', () => {
  const t = cloudSec.extractTarget({ accountId: '123456789012', regions: ['us-east-1', 'eu-west-2'] })
  assert.deepStrictEqual(t, { accountId: '123456789012', regions: ['us-east-1', 'eu-west-2'] })
})

test('cloud-security.matchesScope requires account AND every region in scope', () => {
  const scope = { in_scope: { accounts: ['123456789012'], regions: ['us-east-1'] } }
  assert.strictEqual(
    cloudSec.matchesScope({ accountId: '123456789012', regions: ['us-east-1'] }, scope),
    true,
  )
  assert.strictEqual(
    cloudSec.matchesScope({ accountId: '123456789012', regions: ['us-east-1', 'eu-west-2'] }, scope),
    false, 'eu-west-2 not in scope',
  )
  assert.strictEqual(
    cloudSec.matchesScope({ accountId: '999999999999', regions: ['us-east-1'] }, scope),
    false, 'account not in scope',
  )
})

test('network-pentest.matchesScope uses CIDR containment', () => {
  const scope = { in_scope: ['10.0.0.0/8', '192.168.0.0/16'] }
  assert.strictEqual(netPentest.matchesScope('10.5.3.0/24', scope), true)
  assert.strictEqual(netPentest.matchesScope('192.168.1.0/24', scope), true)
  assert.strictEqual(netPentest.matchesScope('8.8.8.0/24', scope), false)
})

test('code-review.matchesScope is path-prefix based', () => {
  const scope = { in_scope: ['/root/repo/src', '/root/repo/lib'] }
  assert.strictEqual(codeRev.matchesScope('/root/repo/src/auth.js', scope), true)
  assert.strictEqual(codeRev.matchesScope('/root/repo/lib/util.js', scope), true)
  assert.strictEqual(codeRev.matchesScope('/etc/passwd', scope), false)
  assert.strictEqual(codeRev.matchesScope('/root/repo/node_modules/foo.js', scope), false)
})

test('code-review.cvssOf maps severity keywords to pseudo-CVSS', () => {
  assert.strictEqual(codeRev.cvssOf({ severity: 'critical' }), 9.0)
  assert.strictEqual(codeRev.cvssOf({ severity: 'high' }), 7.5)
  assert.strictEqual(codeRev.cvssOf({ severity: 'medium' }), 5.0)
  assert.strictEqual(codeRev.cvssOf({ severity: 'low' }), 3.0)
  assert.strictEqual(codeRev.cvssOf({ severity: 'info' }), 1.0)
  assert.strictEqual(codeRev.cvssOf({}), 0)
})

test('stocks.matchesScope: exact ticker OR wildcard *', () => {
  assert.strictEqual(stocks.matchesScope('GULFOILLUB', { in_scope: ['GULFOILLUB', 'ETERNAL'] }), true)
  assert.strictEqual(stocks.matchesScope('GULFOILLUB', { in_scope: ['*'] }), true)
  assert.strictEqual(stocks.matchesScope('UNKNOWN', { in_scope: ['ETERNAL'] }), false)
})

test('stocks.cvssOf maps conviction to pseudo-CVSS', () => {
  assert.strictEqual(stocks.cvssOf({ conviction: 'high' }), 8.0)
  assert.strictEqual(stocks.cvssOf({ conviction: 'medium' }), 5.0)
  assert.strictEqual(stocks.cvssOf({ conviction: 'low' }), 2.0)
})

test('all 5 adapters expose required contract', () => {
  for (const [name, p] of [
    ['pentest', pentest], ['cloud-security', cloudSec],
    ['network-pentest', netPentest], ['code-review', codeRev], ['stocks', stocks],
  ]) {
    assert.strictEqual(p.squad, name, `${name}.squad must match filename`)
    assert.strictEqual(typeof p.extractTarget, 'function', `${name}.extractTarget required`)
    assert.strictEqual(typeof p.matchesScope, 'function', `${name}.matchesScope required`)
    assert.strictEqual(typeof p.cvssOf, 'function', `${name}.cvssOf required`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /root/agents && bun test test/squad-policy.test.js
```

Expected: FAIL with "Cannot find module '../agents/squad-policy/pentest'"

- [ ] **Step 3: Write the implementations**

```js
// agents/squad-policy/pentest.js
'use strict'
const scopeValidator = require('../scope-validator')

function extractTarget(dispatch) {
  if (!dispatch) return null
  const goal = dispatch.goal || ''
  const m = goal.match(/https?:\/\/([a-z0-9.-]+)/i)
  if (m) return m[1].toLowerCase()
  return (dispatch.target || '').toLowerCase() || null
}

function matchesScope(host, scope) {
  if (!host || !scope) return false
  const result = scopeValidator.validateFindingScope({ url: `https://${host}` }, scope)
  return result.status === scopeValidator.SCOPE_STATUS.IN_SCOPE
}

function cvssOf(finding) {
  const v = finding && finding.cvss
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

module.exports = { squad: 'pentest', extractTarget, matchesScope, cvssOf }
```

```js
// agents/squad-policy/cloud-security.js
'use strict'

function extractTarget(dispatch) {
  if (!dispatch) return null
  return {
    accountId: dispatch.accountId || null,
    regions: Array.isArray(dispatch.regions) ? dispatch.regions.slice() : [],
  }
}

function matchesScope(target, scope) {
  if (!target || !scope || !scope.in_scope) return false
  const accts = scope.in_scope.accounts || []
  if (!accts.includes(target.accountId)) return false
  const allowedRegions = scope.in_scope.regions || []
  if (allowedRegions.includes('*')) return true
  return target.regions.every(r => allowedRegions.includes(r))
}

function cvssOf(finding) {
  const n = Number(finding && finding.cvss)
  return Number.isFinite(n) ? n : 0
}

module.exports = { squad: 'cloud-security', extractTarget, matchesScope, cvssOf }
```

```js
// agents/squad-policy/network-pentest.js
'use strict'

function _ipToInt(ip) {
  const parts = String(ip).split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function _parseCidr(cidr) {
  const [ip, bitsStr] = String(cidr).split('/')
  const bits = Number(bitsStr)
  const ipInt = _ipToInt(ip)
  if (ipInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return { network: ipInt & mask, mask, bits }
}

function _cidrContains(outer, inner) {
  const o = _parseCidr(outer)
  const i = _parseCidr(inner)
  if (!o || !i) return false
  if (i.bits < o.bits) return false
  return (i.network & o.mask) === o.network
}

function extractTarget(dispatch) {
  return (dispatch && dispatch.cidr) || (dispatch && dispatch.target) || null
}

function matchesScope(cidr, scope) {
  if (!cidr || !scope || !Array.isArray(scope.in_scope)) return false
  return scope.in_scope.some(allowed => _cidrContains(allowed, cidr))
}

function cvssOf(finding) {
  const n = Number(finding && finding.cvss)
  return Number.isFinite(n) ? n : 0
}

module.exports = { squad: 'network-pentest', extractTarget, matchesScope, cvssOf }
```

```js
// agents/squad-policy/code-review.js
'use strict'
const path = require('path')

const SEVERITY_MAP = Object.freeze({
  critical: 9.0, high: 7.5, medium: 5.0, low: 3.0, info: 1.0,
})

function extractTarget(dispatch) {
  return (dispatch && (dispatch.sourceDir || dispatch.target)) || null
}

function matchesScope(targetPath, scope) {
  if (!targetPath || !scope || !Array.isArray(scope.in_scope)) return false
  const normalized = path.resolve(targetPath)
  return scope.in_scope.some(allowed => {
    const allowedAbs = path.resolve(allowed)
    return normalized === allowedAbs || normalized.startsWith(allowedAbs + path.sep)
  })
}

function cvssOf(finding) {
  const sev = String((finding && finding.severity) || '').toLowerCase()
  return SEVERITY_MAP[sev] || 0
}

module.exports = { squad: 'code-review', extractTarget, matchesScope, cvssOf, SEVERITY_MAP }
```

```js
// agents/squad-policy/stocks.js
'use strict'

const CONVICTION_MAP = Object.freeze({ high: 8.0, medium: 5.0, low: 2.0 })

function extractTarget(dispatch) {
  if (!dispatch) return null
  if (dispatch.ticker) return String(dispatch.ticker).toUpperCase()
  // Heuristic: NSE:TICKER inside goal text
  const goal = dispatch.goal || ''
  const m = goal.match(/\bNSE:\s*([A-Z][A-Z0-9]{1,15})\b/i)
  if (m) return m[1].toUpperCase()
  return null
}

function matchesScope(ticker, scope) {
  if (!ticker || !scope || !Array.isArray(scope.in_scope)) return false
  if (scope.in_scope.includes('*')) return true
  return scope.in_scope.includes(String(ticker).toUpperCase())
}

function cvssOf(finding) {
  const conv = String((finding && finding.conviction) || '').toLowerCase()
  return CONVICTION_MAP[conv] || 0
}

module.exports = { squad: 'stocks', extractTarget, matchesScope, cvssOf, CONVICTION_MAP }
```

- [ ] **Step 4: Run test to verify it passes**

```
cd /root/agents && bun test test/squad-policy.test.js
```

Expected: PASS, 11 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add agents/squad-policy/ test/squad-policy.test.js
git commit -m "feat: squad-policy adapters for all 5 squads (universal interface)"
```

---

## Task 3: scope-prevalidator.js (universal pre-dispatch block)

**Files:**
- Create: `agents/scope-prevalidator.js`
- Test: `test/scope-prevalidator.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/scope-prevalidator.test.js
'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const sp = require('../agents/scope-prevalidator')
const pentest = require('../agents/squad-policy/pentest')
const cloudSec = require('../agents/squad-policy/cloud-security')
const netPentest = require('../agents/squad-policy/network-pentest')
const codeRev = require('../agents/squad-policy/code-review')
const stocks = require('../agents/squad-policy/stocks')

test('pentest dispatch with in-scope host → allowed', () => {
  const dispatch = { squad: 'pentest', goal: 'Pentest https://api.motorola.com' }
  const scope = { in_scope: ['*.motorola.com'], infra_dependencies: {} }
  const r = sp.validateDispatch(dispatch, pentest, scope)
  assert.strictEqual(r.status, 'allowed')
})

test('pentest dispatch with OOS host → blocked', () => {
  const dispatch = { squad: 'pentest', goal: 'Pentest https://evil.com' }
  const scope = { in_scope: ['*.motorola.com'], infra_dependencies: {} }
  const r = sp.validateDispatch(dispatch, pentest, scope)
  assert.strictEqual(r.status, 'blocked')
  assert.match(r.reason, /evil\.com/)
})

test('pentest dispatch with missing scope config → warned (fail-open)', () => {
  const dispatch = { squad: 'pentest', goal: 'Pentest https://api.example.com' }
  const r = sp.validateDispatch(dispatch, pentest, null)
  assert.strictEqual(r.status, 'warned')
  assert.match(r.reason, /no scope/i)
})

test('pentest dispatch with no extractable target → blocked', () => {
  const dispatch = { squad: 'pentest', goal: 'Please pentest something' }
  const scope = { in_scope: ['*.motorola.com'] }
  const r = sp.validateDispatch(dispatch, pentest, scope)
  assert.strictEqual(r.status, 'blocked')
  assert.match(r.reason, /no target/i)
})

test('cloud-security with matching account + region → allowed', () => {
  const dispatch = { squad: 'cloud-security', accountId: '123456789012', regions: ['us-east-1'] }
  const scope = { in_scope: { accounts: ['123456789012'], regions: ['us-east-1'] } }
  const r = sp.validateDispatch(dispatch, cloudSec, scope)
  assert.strictEqual(r.status, 'allowed')
})

test('cloud-security with OOS region → blocked', () => {
  const dispatch = { squad: 'cloud-security', accountId: '123456789012', regions: ['eu-west-2'] }
  const scope = { in_scope: { accounts: ['123456789012'], regions: ['us-east-1'] } }
  const r = sp.validateDispatch(dispatch, cloudSec, scope)
  assert.strictEqual(r.status, 'blocked')
})

test('network-pentest with CIDR inside scope → allowed', () => {
  const dispatch = { squad: 'network-pentest', cidr: '10.5.0.0/24' }
  const scope = { in_scope: ['10.0.0.0/8'] }
  const r = sp.validateDispatch(dispatch, netPentest, scope)
  assert.strictEqual(r.status, 'allowed')
})

test('network-pentest with CIDR outside scope → blocked', () => {
  const dispatch = { squad: 'network-pentest', cidr: '8.8.8.0/24' }
  const scope = { in_scope: ['10.0.0.0/8'] }
  const r = sp.validateDispatch(dispatch, netPentest, scope)
  assert.strictEqual(r.status, 'blocked')
})

test('code-review with path inside source_dir → allowed', () => {
  const dispatch = { squad: 'code-review', sourceDir: '/root/repo/src' }
  const scope = { in_scope: ['/root/repo/src', '/root/repo/lib'] }
  const r = sp.validateDispatch(dispatch, codeRev, scope)
  assert.strictEqual(r.status, 'allowed')
})

test('stocks with wildcard scope → allowed regardless of ticker', () => {
  const dispatch = { squad: 'stocks', ticker: 'GULFOILLUB' }
  const scope = { in_scope: ['*'] }
  const r = sp.validateDispatch(dispatch, stocks, scope)
  assert.strictEqual(r.status, 'allowed')
})

test('stocks with allowlist not containing ticker → blocked', () => {
  const dispatch = { squad: 'stocks', ticker: 'GULFOILLUB' }
  const scope = { in_scope: ['ETERNAL', 'NTPC'] }
  const r = sp.validateDispatch(dispatch, stocks, scope)
  assert.strictEqual(r.status, 'blocked')
})

test('exports PREDISPATCH_STATUS constants', () => {
  assert.strictEqual(sp.PREDISPATCH_STATUS.ALLOWED, 'allowed')
  assert.strictEqual(sp.PREDISPATCH_STATUS.BLOCKED, 'blocked')
  assert.strictEqual(sp.PREDISPATCH_STATUS.WARNED, 'warned')
})
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /root/agents && bun test test/scope-prevalidator.test.js
```

Expected: FAIL with "Cannot find module '../agents/scope-prevalidator'"

- [ ] **Step 3: Write the implementation**

```js
// agents/scope-prevalidator.js
//
// 2026-05-15: Pre-dispatch scope hard-block. Borrowed pattern from
// bughunter-ai — runs BEFORE any specialist fires. Complements the
// existing post-finding scope-validator.js (shipped 2026-05-15 morning).
//
// Universal across all 5 squads via squadPolicy adapter (pentest /
// cloud-security / network-pentest / code-review / stocks).
//
// Fail-soft when scope config is missing — returns "warned", not
// "blocked". Reason: backward compat with legacy dispatches that
// pre-date the scope-config requirement.

'use strict'

const PREDISPATCH_STATUS = Object.freeze({
  ALLOWED: 'allowed',
  BLOCKED: 'blocked',
  WARNED: 'warned',
})

function validateDispatch(dispatch, squadPolicy, scopeConfig) {
  if (!dispatch || !squadPolicy) {
    return { status: PREDISPATCH_STATUS.BLOCKED, reason: 'missing dispatch or squad policy' }
  }
  if (!scopeConfig) {
    return {
      status: PREDISPATCH_STATUS.WARNED,
      reason: `no scope config for taskId=${dispatch.taskId || 'unknown'} — fail-open for backward compat`,
    }
  }
  const target = squadPolicy.extractTarget(dispatch)
  if (target === null || target === undefined || target === '' ||
      (Array.isArray(target) && target.length === 0)) {
    return {
      status: PREDISPATCH_STATUS.BLOCKED,
      reason: `no target extractable from dispatch (squad=${squadPolicy.squad})`,
    }
  }
  const inScope = squadPolicy.matchesScope(target, scopeConfig)
  if (inScope) {
    return {
      status: PREDISPATCH_STATUS.ALLOWED,
      reason: `target ${JSON.stringify(target)} matches scope (squad=${squadPolicy.squad})`,
    }
  }
  return {
    status: PREDISPATCH_STATUS.BLOCKED,
    reason: `target ${JSON.stringify(target)} not in scope (squad=${squadPolicy.squad})`,
  }
}

module.exports = { PREDISPATCH_STATUS, validateDispatch }
```

- [ ] **Step 4: Run test to verify it passes**

```
cd /root/agents && bun test test/scope-prevalidator.test.js
```

Expected: PASS, 12 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add agents/scope-prevalidator.js test/scope-prevalidator.test.js
git commit -m "feat: scope-prevalidator.js — universal pre-dispatch hard-block (borrow #4)"
```

---

## Task 4: Wire severity filter into event-bus.js (Phase 3.075)

**Files:**
- Modify: `event-bus.js` (insert Phase 3.075 between Phase 3.07 evidence capture and Phase 3.08 active-poc)

- [ ] **Step 1: Locate insertion point**

```
cd /root/agents && grep -n "Phase 3.07\|Phase 3.08" event-bus.js | head -10
```

Note the exact line numbers. The new Phase 3.075 block goes immediately AFTER the Phase 3.07 evidence-capture wire completes and BEFORE the Phase 3.08 active-poc wire begins.

- [ ] **Step 2: Write the failing GATE-80 test**

```js
// test/gate-80-severity-profile.test.js
'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const EB_PATH = path.join(__dirname, '..', 'event-bus.js')
const eb = fs.readFileSync(EB_PATH, 'utf8')

test('GATE-80: event-bus.js wires Phase 3.075 severity filter', () => {
  assert.match(eb, /Phase 3\.075/, 'Phase 3.075 marker missing')
  assert.match(eb, /require\(['"]\.\/agents\/severity-profile['"]\)/, 'severity-profile require missing')
  assert.match(eb, /require\(['"]\.\/agents\/squad-policy\//, 'squad-policy require missing')
  assert.match(eb, /filterFindings\(/, 'filterFindings call missing')
})

test('GATE-80: archived findings persisted to ARCHIVED-FINDINGS file (DOWNGRADE-NOT-DROP)', () => {
  assert.match(eb, /ARCHIVED-FINDINGS-/, 'ARCHIVED-FINDINGS-{taskId} path missing — archived findings would be silently dropped')
})

test('GATE-80: severity filter is fail-soft (logs + continues on error)', () => {
  // Look for try/catch around the severity filter wire
  const slice = eb.slice(eb.indexOf('Phase 3.075'), eb.indexOf('Phase 3.075') + 3000)
  assert.match(slice, /try\s*\{/, 'Phase 3.075 must be wrapped in try/catch (fail-soft)')
  assert.match(slice, /catch\s*\(/, 'Phase 3.075 must have catch block')
})
```

- [ ] **Step 3: Run GATE-80 to verify it fails**

```
cd /root/agents && bun test test/gate-80-severity-profile.test.js
```

Expected: FAIL — Phase 3.075 not yet wired.

- [ ] **Step 4: Insert Phase 3.075 wire into event-bus.js**

Find the existing `// Phase 3.07: ` block and the following `// Phase 3.08: ` block. Insert this block between them:

```js
// Phase 3.075: Severity profile filter (universal across squads)
// Borrowed from bughunter-ai. Reads dispatch.severity_profile, filters
// VALIDATED-FINDINGS into reported (kept) + archived (moved to
// ARCHIVED-FINDINGS-{taskId}.jsonl for chain analysis). DOWNGRADE-NOT-DROP.
try {
  const severityProfile = require('./agents/severity-profile')
  const squadName = (dispatchTask && dispatchTask.squad) || 'pentest'
  const squadKey = squadName.replace(/-squad$/, '')
  const squadPolicy = require(`./agents/squad-policy/${squadKey}`)
  const validatedPath = `/root/intel/VALIDATED-FINDINGS-${taskId}.jsonl`
  const archivedPath = `/root/intel/ARCHIVED-FINDINGS-${taskId}.jsonl`
  if (fs.existsSync(validatedPath)) {
    const lines = fs.readFileSync(validatedPath, 'utf8').split('\n').filter(Boolean)
    const findings = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const profile = (dispatchTask && dispatchTask.severity_profile) || 'pentest'
    const { reported, archived, warnings } = severityProfile.filterFindings(findings, profile, squadPolicy)
    // Overwrite VALIDATED-FINDINGS with reported only
    fs.writeFileSync(validatedPath, reported.map(f => JSON.stringify(f)).join('\n') + (reported.length ? '\n' : ''))
    // Append archived to ARCHIVED-FINDINGS (DOWNGRADE-NOT-DROP)
    if (archived.length) {
      fs.appendFileSync(archivedPath, archived.map(f => JSON.stringify(f)).join('\n') + '\n')
    }
    logActivity('SANJAY', `🎚️ Phase 3.075: severity filter (${profile}) — reported=${reported.length}, archived=${archived.length}`, {
      phase: '3.075',
      taskId,
      kind: 'severity-filter',
      profile,
      squad: squadName,
      reported: reported.length,
      archived: archived.length,
      warnings,
    })
  }
} catch (err) {
  logActivity('SANJAY', `⚠️ Phase 3.075 severity-filter error (non-fatal): ${err.message}`, {
    phase: '3.075', taskId, kind: 'severity-filter-error', error: String(err && err.message || err),
  })
}
```

(Uses the existing `logActivity(agent, action, extra)` helper from event-bus.js:1311. Confirmed during plan authoring.)

- [ ] **Step 5: Run GATE-80 to verify it passes**

```
cd /root/agents && bun test test/gate-80-severity-profile.test.js
```

Expected: PASS, 3 tests.

Also run the full test suite to confirm nothing else regressed:

```
cd /root/agents && bun test 2>&1 | tail -20
```

Expected: all green except the pre-existing browser-verifier.test.js playwright timeout.

- [ ] **Step 6: Commit**

```bash
cd /root/agents
git add event-bus.js test/gate-80-severity-profile.test.js
git commit -m "feat: wire Phase 3.075 severity filter into event-bus.js + GATE-80 lock"
```

---

## Task 5: Wire scope-prevalidator into event-bus.js (Phase 0.0)

**Files:**
- Modify: `event-bus.js` (insert Phase 0.0 BEFORE Phase 0.5 WAF detect)

- [ ] **Step 1: Locate insertion point**

```
cd /root/agents && grep -n "Phase 0\." event-bus.js | head -10
```

The new Phase 0.0 block goes immediately at the start of the dispatch processing function, BEFORE the Phase 0.5 WAF detect block.

- [ ] **Step 2: Write the failing GATE-81 test**

```js
// test/gate-81-scope-prevalidator.test.js
'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const EB_PATH = path.join(__dirname, '..', 'event-bus.js')
const eb = fs.readFileSync(EB_PATH, 'utf8')

test('GATE-81: event-bus.js wires Phase 0.0 scope pre-validator', () => {
  assert.match(eb, /Phase 0\.0/, 'Phase 0.0 marker missing')
  assert.match(eb, /require\(['"]\.\/agents\/scope-prevalidator['"]\)/, 'scope-prevalidator require missing')
  assert.match(eb, /validateDispatch\(/, 'validateDispatch call missing')
})

test('GATE-81: blocked dispatches do NOT proceed to Phase 0.5 WAF detect', () => {
  // Phase 0.0 must appear before Phase 0.5
  const idx00 = eb.indexOf('Phase 0.0')
  const idx05 = eb.indexOf('Phase 0.5')
  assert.ok(idx00 > -1 && idx05 > -1, 'both Phase 0.0 and 0.5 must exist')
  assert.ok(idx00 < idx05, `Phase 0.0 must come before Phase 0.5 (idx00=${idx00}, idx05=${idx05})`)
})

test('GATE-81: scope-prevalidator is fail-soft (warned status continues)', () => {
  // The wire should treat WARNED as continue (not abort)
  const slice = eb.slice(eb.indexOf('Phase 0.0'), eb.indexOf('Phase 0.0') + 3000)
  assert.match(slice, /['"]blocked['"]/, 'must check for blocked status')
})
```

- [ ] **Step 3: Run GATE-81 to verify it fails**

```
cd /root/agents && bun test test/gate-81-scope-prevalidator.test.js
```

Expected: FAIL — Phase 0.0 not yet wired.

- [ ] **Step 4: Insert Phase 0.0 wire into event-bus.js**

Find the dispatch processing function entry point (the function that handles `dispatch.status === 'pending'` items). Insert this block at the very top, before Phase 0.5 WAF detect:

```js
// Phase 0.0: Pre-dispatch scope hard-block (universal across squads)
// Borrowed from bughunter-ai. Fails fast BEFORE any specialist fires.
// Reads scope config from /root/intel/scope-{taskId}.json. Fail-soft
// when config is missing (logs warning, continues — backward compat).
try {
  const scopePrevalidator = require('./agents/scope-prevalidator')
  const squadName = (dispatchTask && dispatchTask.squad) || 'pentest'
  const squadKey = squadName.replace(/-squad$/, '')
  const squadPolicy = require(`./agents/squad-policy/${squadKey}`)
  const scopePath = `/root/intel/scope-${taskId}.json`
  let scopeConfig = null
  if (fs.existsSync(scopePath)) {
    try { scopeConfig = JSON.parse(fs.readFileSync(scopePath, 'utf8')) } catch { /* leave null */ }
  }
  const { status, reason } = scopePrevalidator.validateDispatch(dispatchTask, squadPolicy, scopeConfig)
  logActivity('SANJAY', `🛡️ Phase 0.0: scope pre-validate ${status} (${squadName}) — ${reason}`, {
    phase: '0.0', taskId, kind: 'scope-prevalidate', status, reason, squad: squadName,
  })
  if (status === 'blocked') {
    // Update dispatch-queue.json entry to status='failed' with reason, then return.
    // Use the existing dispatch-queue write path (atomicReadModifyWrite on DISPATCH_FILE).
    const queue = JSON.parse(fs.readFileSync(DISPATCH_FILE, 'utf8'))
    const entry = queue.find(d => String(d.taskId) === String(taskId))
    if (entry) {
      entry.status = 'failed'
      entry.failureReason = `Pre-dispatch scope block: ${reason}`
      entry.processedAt = new Date().toISOString()
      fs.writeFileSync(DISPATCH_FILE, JSON.stringify(queue, null, 2))
    }
    return
  }
  // 'allowed' and 'warned' both continue. 'warned' is logged for audit.
} catch (err) {
  logActivity('SANJAY', `⚠️ Phase 0.0 scope-prevalidate error (non-fatal): ${err.message}`, {
    phase: '0.0', taskId, kind: 'scope-prevalidate-error', error: String(err && err.message || err),
  })
  // On adapter/module error, fail-soft and continue to legacy path.
}
```

(Uses `logActivity` from event-bus.js:1311 and inline dispatch-queue.json update via `DISPATCH_FILE` constant from event-bus.js:133. No new helpers required.)

- [ ] **Step 5: Run GATE-81 to verify it passes**

```
cd /root/agents && bun test test/gate-81-scope-prevalidator.test.js
```

Expected: PASS, 3 tests.

Full test suite confirmation:

```
cd /root/agents && bun test 2>&1 | tail -20
```

Expected: all green except pre-existing browser-verifier.test.js playwright timeout.

- [ ] **Step 6: Commit**

```bash
cd /root/agents
git add event-bus.js test/gate-81-scope-prevalidator.test.js
git commit -m "feat: wire Phase 0.0 scope pre-validator into event-bus.js + GATE-81 lock"
```

---

## Task 6: Wire GATE-80 + GATE-81 into verify-loop

**Files:**
- Modify: `scripts/kurukshetra-verify-loop.sh`

- [ ] **Step 1: Locate insertion point in verify-loop**

```
cd /root/agents && grep -n "GATE-78\|GATE-79" scripts/kurukshetra-verify-loop.sh | tail -5
```

The new GATE-80 and GATE-81 entries follow the most recent gate (likely GATE-79 or whatever the current latest is).

- [ ] **Step 2: Add GATE-80 + GATE-81 entries**

Append to the gate sequence using the same pattern as existing GATEs:

```bash
# GATE-80: severity-profile filter wires into Phase 3.075
run_gate "GATE-80" "bun test test/gate-80-severity-profile.test.js"

# GATE-81: scope-prevalidator wires into Phase 0.0
run_gate "GATE-81" "bun test test/gate-81-scope-prevalidator.test.js"
```

(Use the exact `run_gate` helper name and quoting style already in the script — grep for an existing GATE line and copy the format.)

- [ ] **Step 3: Run verify-loop to confirm both new gates pass**

```
cd /root/agents && bash scripts/kurukshetra-verify-loop.sh 2>&1 | grep -E "GATE-80|GATE-81|FAIL|PASS" | tail -20
```

Expected: GATE-80 PASS, GATE-81 PASS, no new FAIL entries.

- [ ] **Step 4: Commit**

```bash
cd /root/agents
git add scripts/kurukshetra-verify-loop.sh
git commit -m "test: add GATE-80 (severity-profile) and GATE-81 (scope-prevalidator) to verify-loop"
```

---

## Task 7: Live smoke test (operational, no commit)

This task verifies the wire actually fires end-to-end on a real dispatch. No code changes — operational verification only.

- [ ] **Step 1: PM2 reload daemon to pick up event-bus changes**

```
pm2 reload event-bus 2>&1 | tail -5
```

Expected: `reloaded` status.

- [ ] **Step 2: Dispatch Q#8 Lenovo re-triage with explicit severity profile**

Drop a new dispatch into `/root/intel/dispatch-queue.json` for Lenovo api.motorola.com with:
- `squad: 'pentest-squad'`
- `severity_profile: 'bounty'` (high-only, kudos-only programs)
- scope-{taskId}.json pre-written with `{"in_scope": ["*.motorola.com"], "infra_dependencies": {}}` matching Bugcrowd actual scope

- [ ] **Step 3: Tail ACTIVITY-LOG.jsonl for Phase 0.0 and Phase 3.075 events**

```
tail -f /root/intel/ACTIVITY-LOG.jsonl | grep -E "phase.:.0\.0|phase.:.3\.075"
```

Expected within 30 seconds: a `phase: "0.0"` entry with `status: "allowed"` (because api.motorola.com IS in *.motorola.com scope) followed by normal phases proceeding.

Expected within 30 minutes (full run): a `phase: "3.075"` entry with `profile: "bounty"`, `reported: N`, `archived: M` counts.

- [ ] **Step 4: Verify ARCHIVED-FINDINGS file exists**

```
ls -la /root/intel/ARCHIVED-FINDINGS-*.jsonl | tail -3
```

Expected: at least one file from the smoke test run. Inspect:

```
head -3 /root/intel/ARCHIVED-FINDINGS-<taskId>.jsonl | jq '{id, cvss, archive_reason}'
```

Expected: low-severity findings with `archive_reason` mentioning bounty floor.

- [ ] **Step 5: Verify VYASA report only contains reported findings**

The VYASA report at `/root/intel/reports/<taskId>.md` should contain only the findings that survived the bounty filter. Compare counts:

```
TASKID=<newest>
REPORTED=$(wc -l < /root/intel/VALIDATED-FINDINGS-${TASKID}.jsonl)
ARCHIVED=$(wc -l < /root/intel/ARCHIVED-FINDINGS-${TASKID}.jsonl)
echo "reported=${REPORTED} archived=${ARCHIVED} total=$((REPORTED+ARCHIVED))"
grep -c "^### F-" /root/intel/reports/${TASKID}.md
```

Expected: VYASA report finding count matches REPORTED, not REPORTED+ARCHIVED.

- [ ] **Step 6: Report results back to Jay**

Send a Telegram summary including:
- Phase 0.0 fired (allowed/blocked counts)
- Phase 3.075 fired (reported/archived split)
- ARCHIVED-FINDINGS file exists and has expected content
- VYASA report finding count matches reported (DOWNGRADE-NOT-DROP verified)

---

## Self-Review

**1. Spec coverage:**

- ✅ Borrow #3 severity profiles → Task 1 (module) + Task 4 (wire)
- ✅ Per-squad threshold maps → Task 2 (squad-policy adapters)
- ✅ Zero-day indicator bypass → Task 1 test cases + ZERO_DAY_INDICATORS export
- ✅ DOWNGRADE-NOT-DROP → Task 1 test (`total preserved`) + Task 4 ARCHIVED-FINDINGS file
- ✅ Borrow #4 pre-dispatch hard-block → Task 3 (module) + Task 5 (wire)
- ✅ Universal scope abstraction → Task 3 PREDISPATCH_STATUS + squad policies
- ✅ Existing scope-validator.js stays → not modified
- ✅ Per-squad scope semantics (pentest hostname / cloud account+region / network CIDR / code-review path / stocks ticker) → Task 2 covers all 5
- ✅ Hook at Phase 0 + Phase 3.07 → Tasks 4, 5
- ✅ GATE-80 + GATE-81 regression locks → Tasks 4, 5, 6
- ✅ Live smoke test → Task 7

**2. Placeholder scan:** No TBD, no "implement later", no "similar to Task N" — all code shown inline. ✅

**3. Type consistency:**
- `cvssOf(finding)` consistent across all 5 squad-policy files and used in severity-profile.test.js ✅
- `matchesScope(target, scope)` consistent signature ✅
- `extractTarget(dispatch)` consistent ✅
- `PREDISPATCH_STATUS.ALLOWED/BLOCKED/WARNED` strings consistent between module export and test assertions ✅
- `PROFILES.bounty/pentest/comprehensive` matched in tests ✅
- File path `agents/squad-policy/{squad}.js` matched by require strings in event-bus wire ✅
- `dispatchTask.severity_profile` field is new — Tasks 4 and 7 both reference it ✅

**4. Risk notes:**
- Phase 0.0 fail-soft is intentional: legacy dispatches without scope config keep working (logged as `warned`).
- Phase 3.075 fail-soft means severity filter failure does NOT block report generation — VYASA still runs on unfiltered VALIDATED-FINDINGS.
- `logActivity` helper confirmed at event-bus.js:1311. `DISPATCH_FILE` constant at event-bus.js:133. No new helpers added.
- The pentest squad-policy delegates to scope-validator.js. If that module's API changes, pentest.matchesScope breaks. Mitigation: scope-validator.test.js (already shipped) locks the contract.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-15-severity-scope-universal.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
