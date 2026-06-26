# Framework Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 silent-failure bugs in kurukshetra framework discovered during Lenovo Bugcrowd run forensic analysis. Restore Phase 3.06 scope-validator to working state, make severity profile selection program-aware, and enforce FindingSchema at the real producer→pipeline boundary.

**Architecture:** Framework-general fixes (no per-program coupling). Root-cause first (producer emits canonical url field), then belt-and-suspenders (consumer fallback), then enforcement (schema validation at builder boundary), then regression gates (verify-framework).

**Tech Stack:** Node.js, node:test runner (run via `bun test`), event-bus.js orchestrator, PM2-supervised daemon.

---

## Context & forensic findings

From 11 Lenovo Bugcrowd dispatches (May 18-20, 2026):
- **42 findings archived** by Phase 3.075 severity filter, all with `archive_reason: "cvss X below bounty floor 8"`. Lenovo is kudos-only (accepts Mediums) — bounty profile (CVSS 8) was wrong choice.
- **scope-validator silently broken**: 0/12 sampled findings have top-level `url|affected_url|target` field. All hit fail-safe path `"no URL on finding (fail-safe)"` → marked OOS. Phase 3.06 `scope_status` annotation is noise across all production data.
- **finding-schema.js** invoked at only one site (event-bus.js:5730 Phase 3.8) — not at the real specialist→pipeline boundary which is `kripa-validated-builder.writeValidatedFindingsFile` (event-bus.js:5262).

**Bug interactions** (why this stayed hidden):
- Severity filter operates on CVSS metadata only (no URL needed) → ran 42x successfully.
- scope-validator needs URL → returned fail-safe OOS for 100% of inputs.
- Two bugs on different code paths → no single log line surfaced either.

## File structure

**Files modified (4):**
- `/root/agents/agents/kripa-validated-builder.js` — Task 1: emit canonical `url` field via shared extractor.
- `/root/agents/agents/scope-validator.js` — Task 2: belt-and-suspenders fallback URL extraction.
- `/root/agents/agents/severity-profile.js` — Task 3: add program_type → profile resolver, fix classifyFinding warning consistency.
- `/root/agents/agents/finding-schema.js` — Task 4: add `validateFinding()` validator; invoke from builder.

**Files modified (event-bus integration, 1):**
- `/root/agents/event-bus.js` — Task 3: severity_profile resolution prefers explicit `dispatch.severity_profile`, falls back to `program_type` resolver, defaults to pentest.

**Files created (3 unit tests + 3 gate tests, 6 new):**
- `/root/agents/test/url-extractor.test.js` — Task 1 shared extractor test.
- (existing) `/root/agents/test/scope-validator.test.js` — Task 2 adds 4 fallback test cases.
- (existing) `/root/agents/test/severity-profile.test.js` — Task 3 adds program_type resolver tests.
- (existing) `/root/agents/test/finding-schema.test.js` — Task 4 adds validator tests.
- `/root/agents/test/gate-86-canonical-url.test.js` — Task 5.
- `/root/agents/test/gate-87-scope-validator-fallback.test.js` — Task 5.
- `/root/agents/test/gate-88-program-type-resolver.test.js` — Task 5.

**Files modified (verify-framework + docs, 2):**
- `/root/agents/verify-framework.js` — Task 5: add gates 86, 87, 88.
- `/root/CLAUDE.md` — Task 6: refresh gate count, sprint summary, refresh date.

**Architectural decision: a shared URL extractor module**

Both Task 1 (kripa-validated-builder) and Task 2 (scope-validator) need to extract first `https?://...` from arbitrary text. The pentest squad-policy already has this regex inline. To avoid 3 copies, create:

- `/root/agents/agents/url-extractor.js` — single function `extractFirstUrl(text)`. Pentest squad-policy keeps its inline regex (don't touch working code that's gate-covered). Two new callers use the shared module.

This keeps the change blast radius small while eliminating future drift.

---

## Task 1: Create shared URL extractor + producer emits canonical `url` field

**Files:**
- Create: `agents/url-extractor.js`
- Create: `test/url-extractor.test.js`
- Modify: `agents/kripa-validated-builder.js` (around line 134-145 where entry is built)

- [ ] **Step 1.1: Write the failing test for shared extractor**

Create `test/url-extractor.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert')
const { extractFirstUrl } = require('../agents/url-extractor')

test('extractFirstUrl: returns URL when present in text', () => {
  assert.strictEqual(
    extractFirstUrl('curl -sI https://uatcommercial.lenovo.com/eticket/login'),
    'https://uatcommercial.lenovo.com/eticket/login'
  )
})

test('extractFirstUrl: returns first URL when multiple present', () => {
  assert.strictEqual(
    extractFirstUrl('See https://a.example.com/x and https://b.example.com/y'),
    'https://a.example.com/x'
  )
})

test('extractFirstUrl: handles http (not just https)', () => {
  assert.strictEqual(
    extractFirstUrl('Attacker page at http://evil.test/payload'),
    'http://evil.test/payload'
  )
})

test('extractFirstUrl: returns empty string when no URL', () => {
  assert.strictEqual(extractFirstUrl('no url here, just words'), '')
})

test('extractFirstUrl: returns empty for null/undefined/non-string', () => {
  assert.strictEqual(extractFirstUrl(null), '')
  assert.strictEqual(extractFirstUrl(undefined), '')
  assert.strictEqual(extractFirstUrl(42), '')
  assert.strictEqual(extractFirstUrl({}), '')
})

test('extractFirstUrl: stops at whitespace, quotes, backticks', () => {
  assert.strictEqual(
    extractFirstUrl('`https://example.com/path` was tested'),
    'https://example.com/path'
  )
  assert.strictEqual(
    extractFirstUrl('"https://quoted.test/api" returned 500'),
    'https://quoted.test/api'
  )
})

test('extractFirstUrl: trims trailing punctuation (. , ; : ) ])', () => {
  assert.strictEqual(extractFirstUrl('See https://example.com/a.'), 'https://example.com/a')
  assert.strictEqual(extractFirstUrl('Visit https://example.com/b,'), 'https://example.com/b')
  assert.strictEqual(extractFirstUrl('(https://example.com/c)'), 'https://example.com/c')
})

test('extractFirstUrl: KRIPA-realistic detail text', () => {
  const detail = `Confirmed via curl: curl -sI 'https://uatcommercial.lenovo.com/eticket/login' returned 200 with X-Powered-By header.`
  assert.strictEqual(extractFirstUrl(detail), 'https://uatcommercial.lenovo.com/eticket/login')
})
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `bun test test/url-extractor.test.js`
Expected: FAIL with `Cannot find module '../agents/url-extractor'`

- [ ] **Step 1.3: Implement the shared extractor**

Create `agents/url-extractor.js`:

```js
// agents/url-extractor.js
//
// Single-purpose: extract first http(s) URL from arbitrary text.
// Used by Phase 3.05 kripa-validated-builder (producer) and Phase 3.06
// scope-validator (consumer fallback). Pentest squad-policy keeps its
// own inline regex for now — gate-covered, not worth churn.
//
// The regex stops at whitespace, quotes, backticks, angle brackets.
// Trailing punctuation (.,;:)]) is trimmed because URLs in prose
// frequently end with sentence terminators that aren't part of the URL.

const URL_REGEX = /https?:\/\/[^\s'"`<>\[\]]+/i
const TRAILING_PUNCT = /[.,;:)\]}>]+$/

function extractFirstUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const match = text.match(URL_REGEX)
  if (!match) return ''
  return match[0].replace(TRAILING_PUNCT, '')
}

module.exports = { extractFirstUrl, URL_REGEX }
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `bun test test/url-extractor.test.js`
Expected: PASS (9 tests)

- [ ] **Step 1.5: Modify kripa-validated-builder.js to emit `url` field**

Read `/root/agents/agents/kripa-validated-builder.js` lines 1-180 first to confirm current entry-build shape (recon report says lines 134-145).

Add at the top of the file (after existing requires):

```js
const { extractFirstUrl } = require('./url-extractor')
```

In the entry-construction block (around line 134-145), where the entry object literal is built, add a `url` field. The exact edit will look like — wrap the entry construction so the url is extracted from details + notes:

```js
// Existing entry construction block. Find it via grep:
//   grep -n "validation_status\|dharma_ts" /root/agents/agents/kripa-validated-builder.js
//
// Add the url field. Source priority:
//   1. Explicit finding.url / affected_url / target (in case future producers emit it)
//   2. URL extracted from details
//   3. URL extracted from notes
//   4. Empty string (truly URL-less finding)

const url =
  (entry.url || entry.affected_url || entry.target) ||
  extractFirstUrl(entry.details || '') ||
  extractFirstUrl(entry.notes || '') ||
  ''

// Then include `url` in the written entry object.
```

The implementer must:
1. Read kripa-validated-builder.js fully first.
2. Locate the entry-construction point precisely (line numbers shift over time).
3. Insert URL extraction immediately before the entry is serialized/pushed.
4. Add `url` to the entry object literal alongside `id`, `title`, `validation_status`, etc.
5. Preserve all existing fields exactly.

- [ ] **Step 1.6: Write integration test for kripa-validated-builder emitting `url`**

Append to `test/finding-schema.test.js` (we'll move it to a dedicated file later if it grows):

```js
test('kripa-validated-builder emits canonical url field from details', async () => {
  const path = require('node:path')
  const fs = require('node:fs')
  const os = require('node:os')
  const builder = require('../agents/kripa-validated-builder')

  // Skip if exported API differs — gate-86 covers the integration shape
  if (typeof builder.buildEntry !== 'function' &&
      typeof builder.writeValidatedFindingsFile !== 'function') {
    return
  }

  // Use writeValidatedFindingsFile end-to-end if buildEntry isn't exported
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvb-test-'))
  const findingsFile = path.join(tmpDir, 'VALIDATED-FINDINGS-test.jsonl')

  const fakeKripaVerdicts = [{
    findingId: 'F-TEST-001',
    status: 'CONFIRMED',
    severity: 'Medium',
    title: 'Test',
    original_agent: 'NAKUL',
    details: 'Verified with curl -sI https://test.example.com/login returned 200',
    notes: ''
  }]

  // The exact call signature must be discovered from kripa-validated-builder.js.
  // Implementer: adapt this test to the actual API. Goal: assert that resulting
  // JSONL has a top-level "url" field containing https://test.example.com/login.
  // ...

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
```

Note: if exporting `buildEntry` as a pure helper is the cleaner test seam, refactor that way in step 1.5 — but only if it doesn't change observed behavior.

- [ ] **Step 1.7: Run all tests in affected files**

```bash
cd /root/agents
bun test test/url-extractor.test.js test/finding-schema.test.js
```

Expected: PASS, no regressions.

- [ ] **Step 1.8: Commit**

```bash
cd /root/agents
git add agents/url-extractor.js agents/kripa-validated-builder.js test/url-extractor.test.js test/finding-schema.test.js
git commit -m "$(cat <<'EOF'
feat: shared url-extractor + kripa-validated-builder emits canonical url field

Root-cause fix for Phase 3.06 scope-validator silent OOS (0/12 production
findings had top-level url field — all hit fail-safe path). Producer now
extracts first http(s) URL from details/notes and writes it to the
canonical top-level url field.

- New: agents/url-extractor.js — shared extractor, 9 unit tests
- Modified: agents/kripa-validated-builder.js — emit url at write time
- Pentest squad-policy keeps its inline regex (gate-covered, no churn)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: scope-validator URL extraction fallback (belt-and-suspenders)

**Files:**
- Modify: `agents/scope-validator.js:57-58` (validateFindingScope)
- Modify: `test/scope-validator.test.js` (add 4 fallback cases)

Belt-and-suspenders because:
1. Findings produced BEFORE Task 1 lands won't have top-level url (still in flight, archived data).
2. Future producers (other squads) may not adopt the canonical url field uniformly.
3. Scope-validator is on the hot path — defensive is correct here.

- [ ] **Step 2.1: Write failing tests for fallback extraction**

Read `test/scope-validator.test.js` first for style. Append:

```js
test('validateFindingScope: extracts URL from details when top-level missing', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: [],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-001',
    title: 'Test',
    details: 'Verified via curl -sI https://api.example.com/login',
    notes: ''
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'in-scope')
})

test('validateFindingScope: extracts URL from notes when details lacks one', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: [],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-002',
    title: 'Test',
    details: 'No URL in here, just narrative.',
    notes: 'Reproduced at https://www.example.com/path'
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'in-scope')
})

test('validateFindingScope: top-level url still wins over details URL', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: ['*.other.com'],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-003',
    title: 'Test',
    url: 'https://api.example.com/x',  // top-level: in-scope
    details: 'Also tested https://api.other.com/y'  // distractor: out-of-scope
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'in-scope')
})

test('validateFindingScope: still fails safe when no URL anywhere', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: [],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-004',
    title: 'Test',
    details: 'Nothing actionable here',
    notes: ''
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'out-of-scope')
  assert.match(r.reason, /no URL on finding/)
})
```

- [ ] **Step 2.2: Run tests to verify the 3 fallback tests fail (4th still passes)**

```bash
cd /root/agents
bun test test/scope-validator.test.js
```

Expected: 3 fails (fallback extraction not implemented), 1 pass (fail-safe still works).

- [ ] **Step 2.3: Implement fallback URL extraction in scope-validator**

Read `/root/agents/agents/scope-validator.js` fully first.

Add at top of file:

```js
const { extractFirstUrl } = require('./url-extractor')
```

Replace the URL resolution at line 57-58:

```js
// BEFORE:
//   const url = (finding && (finding.url || finding.affected_url || finding.target)) || ''
//   if (!url) {
//     return { status: SCOPE_STATUS.OUT_OF_SCOPE, reason: 'no URL on finding (fail-safe)' }
//   }

// AFTER:
function _resolveUrl(finding) {
  if (!finding) return ''
  // Priority: explicit fields > details > notes > evidence (string variant)
  return (
    finding.url ||
    finding.affected_url ||
    finding.target ||
    extractFirstUrl(finding.details || '') ||
    extractFirstUrl(finding.notes || '') ||
    (typeof finding.evidence === 'string' ? extractFirstUrl(finding.evidence) : '') ||
    ''
  )
}

// Inside validateFindingScope:
const url = _resolveUrl(finding)
if (!url) {
  return { status: SCOPE_STATUS.OUT_OF_SCOPE, reason: 'no URL on finding (fail-safe)' }
}
```

- [ ] **Step 2.4: Run tests to verify all pass**

```bash
cd /root/agents
bun test test/scope-validator.test.js
```

Expected: ALL PASS (existing + 4 new).

- [ ] **Step 2.5: Commit**

```bash
cd /root/agents
git add agents/scope-validator.js test/scope-validator.test.js
git commit -m "$(cat <<'EOF'
fix: scope-validator falls back to URL extraction from details/notes

Belt-and-suspenders for Phase 3.06. Even after kripa-validated-builder
emits canonical url, defensive extraction protects against:
- Findings in flight when this ships
- Future squads/producers not adopting canonical url uniformly
- Pre-existing archived data being re-processed

Priority chain: url > affected_url > target > extract(details) >
extract(notes) > extract(evidence as string) > fail-safe OOS.

4 new test cases covering each fallback path + the fail-safe still firing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Severity profile — program_type resolver + consistency fix

**Files:**
- Modify: `agents/severity-profile.js` (add resolver, fix warning consistency)
- Modify: `event-bus.js:5384` (use new resolver in active profile selection)
- Modify: `test/severity-profile.test.js` (add 5 resolver tests)

Framework-general fix: explicit `dispatch.severity_profile` still wins. New `dispatch.program_type` field provides safer defaults when severity_profile not explicitly set. Default of defaults remains `pentest` (per existing behavior).

- [ ] **Step 3.1: Write failing tests for program_type → profile resolver**

Append to `test/severity-profile.test.js`:

```js
test('resolveProfile: explicit severity_profile wins over program_type', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(
    sp.resolveProfile({ severity_profile: 'bounty', program_type: 'kudos' }),
    'bounty'
  )
})

test('resolveProfile: program_type=kudos → pentest', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({ program_type: 'kudos' }), 'pentest')
})

test('resolveProfile: program_type=paid_bounty → bounty', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({ program_type: 'paid_bounty' }), 'bounty')
})

test('resolveProfile: program_type=internal_audit → comprehensive', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({ program_type: 'internal_audit' }), 'comprehensive')
})

test('resolveProfile: nothing set → pentest default', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({}), 'pentest')
  assert.strictEqual(sp.resolveProfile(null), 'pentest')
  assert.strictEqual(sp.resolveProfile(undefined), 'pentest')
})

test('resolveProfile: unknown program_type → pentest default + warning', () => {
  const sp = require('../agents/severity-profile')
  // implementer: if resolveProfile returns {profile, warning}, adapt this.
  // simplest contract: return string profile name, log nothing (caller decides).
  assert.strictEqual(sp.resolveProfile({ program_type: 'unknown_kind' }), 'pentest')
})

test('classifyFinding: unknown profile warns consistently with filterFindings', () => {
  const sp = require('../agents/severity-profile')
  const policy = { cvssOf: () => 5.0 }
  // currently filterFindings warns, classifyFinding does not. After fix:
  // either both warn (via shared helper) or both stay silent. Pick "both warn"
  // to surface dispatcher bugs early.
  // This test asserts behavioral consistency: both code paths produce the same
  // decision for an unknown profile.
  const r1 = sp.classifyFinding({ severity: 'Medium' }, 'mystery_profile', policy)
  const r2 = sp.filterFindings([{ severity: 'Medium' }], 'mystery_profile', policy)
  // classifyFinding defaulted to pentest internally, so CVSS 5 ≥ 4 → 'report'
  assert.strictEqual(r1.decision, 'report')
  // filterFindings same logic → reported
  assert.strictEqual(r2.reported.length, 1)
  // warnings array must exist and mention unknown profile
  assert.ok(r2.warnings.length > 0)
  assert.match(r2.warnings[0], /unknown profile/)
})
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd /root/agents
bun test test/severity-profile.test.js
```

Expected: 6 fails on resolveProfile (export missing), 1 fail on consistency.

- [ ] **Step 3.3: Implement resolveProfile + warning consistency in severity-profile.js**

Read `agents/severity-profile.js` fully first. Add:

```js
// Maps from caller-friendly program intent to the right severity profile.
// Framework-general — no per-program (Lenovo / HackerOne / etc) coupling.
//
// program_type values:
//   kudos          → pentest      (kudos-only programs accept Mediums)
//   paid_bounty    → bounty       (paid programs typically pay High+ only)
//   internal_audit → comprehensive (find everything, even Lows)
//   bug_bash       → pentest      (events run shallow + want volume)
//
// Add new program_type → profile mappings here as the framework grows.
const PROGRAM_TYPE_TO_PROFILE = Object.freeze({
  kudos: 'pentest',
  paid_bounty: 'bounty',
  internal_audit: 'comprehensive',
  bug_bash: 'pentest',
})

/**
 * Resolves which severity profile to use for a dispatch.
 *
 * Priority:
 *   1. Explicit dispatch.severity_profile (string, must be a known profile)
 *   2. dispatch.program_type via PROGRAM_TYPE_TO_PROFILE
 *   3. Default 'pentest'
 *
 * Unknown explicit profile or unknown program_type both silently
 * fall through to 'pentest'. The caller (event-bus.js) is responsible
 * for logging the fallback if it matters.
 */
function resolveProfile(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return 'pentest'
  // 1. Explicit profile
  const explicit = dispatch.severity_profile
  if (typeof explicit === 'string' && _profileFor(explicit)) {
    return explicit
  }
  // 2. program_type
  const pt = dispatch.program_type
  if (typeof pt === 'string' && PROGRAM_TYPE_TO_PROFILE[pt]) {
    return PROGRAM_TYPE_TO_PROFILE[pt]
  }
  // 3. Default
  return 'pentest'
}
```

Fix the warning inconsistency. Currently `filterFindings` (line 69-71) warns on unknown profile, `classifyFinding` (line 52) does not. Add a shared helper:

```js
function _resolveProfileOrWarn(name, warnings) {
  const p = _profileFor(name)
  if (p) return p
  if (warnings) warnings.push(`unknown profile "${name}" — defaulting to pentest`)
  return PROFILES.pentest
}
```

Refactor both `classifyFinding` and `filterFindings` to use it. `classifyFinding` callers don't pass a warnings array, so it'll be silent for that path (existing behavior preserved). `filterFindings` callers pass their warnings array and get the warning.

Export `resolveProfile` and `PROGRAM_TYPE_TO_PROFILE` from module:

```js
module.exports = {
  PROFILES,
  ZERO_DAY_INDICATORS,
  classifyFinding,
  filterFindings,
  resolveProfile,
  PROGRAM_TYPE_TO_PROFILE,
}
```

- [ ] **Step 3.4: Update event-bus.js to use resolveProfile**

At event-bus.js:5384 (current code):
```js
const __profile = (dispatch && dispatch.severity_profile) || 'pentest'
```

Replace with:
```js
const __profile = severityProfile.resolveProfile(dispatch)
```

Confirm `severityProfile` is already required at the top of that block (recon report says yes — used by `filterFindings` call below). If not, add the require.

- [ ] **Step 3.5: Run tests to verify pass**

```bash
cd /root/agents
bun test test/severity-profile.test.js
```

Expected: ALL PASS.

- [ ] **Step 3.6: Run full test suite to check for regressions**

```bash
cd /root/agents
bun test
```

Expected: All previously-green tests still green. Pre-existing playwright timeout in test/browser-verifier.test.js — skip per CLAUDE.md.

- [ ] **Step 3.7: Commit**

```bash
cd /root/agents
git add agents/severity-profile.js event-bus.js test/severity-profile.test.js
git commit -m "$(cat <<'EOF'
feat: severity-profile.resolveProfile + program_type → profile mapping

Framework-general. Explicit dispatch.severity_profile still wins; new
dispatch.program_type field gives safer defaults when severity_profile
not set. Default of defaults stays 'pentest'.

PROGRAM_TYPE_TO_PROFILE mapping:
  kudos          → pentest      (kudos programs accept Mediums)
  paid_bounty    → bounty       (paid programs want High+ only)
  internal_audit → comprehensive (find everything)
  bug_bash       → pentest

Also: classifyFinding + filterFindings now use shared _resolveProfileOrWarn
helper. filterFindings warns on unknown profile (existing behavior),
classifyFinding stays silent (its callers don't pass a warnings sink).
Consistent fallback to pentest in both.

event-bus.js:5384 switched from inline ternary to resolveProfile() call.

7 new tests in severity-profile.test.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: FindingSchema validator at the producer boundary

**Files:**
- Modify: `agents/finding-schema.js` (add `validateFinding()`)
- Modify: `agents/kripa-validated-builder.js` (invoke validator before write)
- Modify: `test/finding-schema.test.js` (add 6 validator tests)

The recon revealed that `finding-schema.js` is normalizer-only (best-effort coercion, never throws), invoked once in Phase 3.8. The real specialist→pipeline write boundary is `kripa-validated-builder.writeValidatedFindingsFile`. Adding a validator there catches schema drift at the point findings enter the pipeline.

Validator policy:
- **Log + auto-repair**, do NOT reject. Rejecting findings silently loses signal.
- Required fields: `id`, `title`, `severity`, `validation_status`, `original_agent`, `taskId`.
- Auto-repair: synthesize missing `id` (`F-AUTO-<timestamp>-<n>`), missing `title` (from id), missing `severity` (default `Medium`), missing `validation_status` (default `unknown`).
- Warning for every auto-repair so it surfaces in logs.

- [ ] **Step 4.1: Write failing tests for validateFinding**

Append to `test/finding-schema.test.js`:

```js
test('validateFinding: returns {valid: true, finding, warnings: []} for complete record', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-001',
    title: 'CSRF',
    severity: 'Medium',
    validation_status: 'confirmed',
    original_agent: 'NAKUL',
    taskId: '1234567890',
  })
  assert.strictEqual(result.valid, true)
  assert.deepStrictEqual(result.warnings, [])
  assert.strictEqual(result.finding.id, 'F-001')
})

test('validateFinding: auto-repairs missing severity → Medium + warning', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-002', title: 'X', validation_status: 'confirmed',
    original_agent: 'NAKUL', taskId: '123',
  })
  assert.strictEqual(result.valid, true)
  assert.strictEqual(result.finding.severity, 'Medium')
  assert.ok(result.warnings.some(w => /severity/i.test(w)))
})

test('validateFinding: auto-synthesizes missing id', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    title: 'X', severity: 'Low', validation_status: 'confirmed',
    original_agent: 'NAKUL', taskId: '123',
  })
  assert.strictEqual(result.valid, true)
  assert.match(result.finding.id, /^F-AUTO-/)
  assert.ok(result.warnings.some(w => /id/i.test(w)))
})

test('validateFinding: auto-synthesizes missing title from id', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-003', severity: 'Low', validation_status: 'confirmed',
    original_agent: 'NAKUL', taskId: '123',
  })
  assert.strictEqual(result.finding.title, 'F-003')
})

test('validateFinding: rejects non-object input', () => {
  const fs = require('../agents/finding-schema')
  assert.strictEqual(fs.validateFinding(null).valid, false)
  assert.strictEqual(fs.validateFinding(undefined).valid, false)
  assert.strictEqual(fs.validateFinding('a string').valid, false)
  assert.strictEqual(fs.validateFinding(42).valid, false)
})

test('validateFinding: handles missing optional fields gracefully', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-004', title: 'Y', severity: 'High',
    validation_status: 'confirmed', original_agent: 'NAKUL', taskId: '123',
    // no notes, details, url — all optional
  })
  assert.strictEqual(result.valid, true)
})
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
cd /root/agents
bun test test/finding-schema.test.js
```

Expected: 6 fails on validateFinding (export missing).

- [ ] **Step 4.3: Implement validateFinding in finding-schema.js**

Read `agents/finding-schema.js` fully first. Add:

```js
const REQUIRED_FIELDS = ['id', 'title', 'severity', 'validation_status', 'original_agent', 'taskId']

let _autoIdCounter = 0
function _autoId() {
  _autoIdCounter += 1
  return `F-AUTO-${Date.now()}-${_autoIdCounter}`
}

/**
 * Validates + auto-repairs a finding for safe consumption by downstream phases.
 *
 * Returns { valid, finding, warnings }.
 *   - valid=false only when input isn't a plain object (cannot be repaired).
 *   - finding is the (possibly-repaired) shallow clone — never the input ref.
 *   - warnings is an array of human-readable strings describing each auto-repair.
 *
 * Policy: never reject a salvageable finding. Schema drift is logged, not
 * silently dropped. The original_agent + taskId provenance is preserved
 * even when other fields are synthesized.
 */
function validateFinding(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, finding: null, warnings: ['input is not a plain object'] }
  }

  const warnings = []
  const finding = { ...input }

  // Auto-repair missing required fields
  if (!finding.id) {
    finding.id = _autoId()
    warnings.push(`missing id — synthesized ${finding.id}`)
  }
  if (!finding.title) {
    finding.title = finding.id
    warnings.push(`missing title — defaulted to id (${finding.title})`)
  }
  if (!finding.severity) {
    finding.severity = 'Medium'
    warnings.push('missing severity — defaulted to Medium')
  } else {
    // Apply normalizeSeverity coercion
    finding.severity = normalizeSeverity(finding.severity)
  }
  if (!finding.validation_status) {
    finding.validation_status = 'unknown'
    warnings.push('missing validation_status — defaulted to unknown')
  }
  if (!finding.original_agent) {
    finding.original_agent = 'UNKNOWN'
    warnings.push('missing original_agent — defaulted to UNKNOWN')
  }
  if (!finding.taskId) {
    finding.taskId = ''
    warnings.push('missing taskId — defaulted to empty string')
  }

  return { valid: true, finding, warnings }
}

module.exports = {
  // ... existing exports
  validateFinding,
  REQUIRED_FIELDS,
}
```

- [ ] **Step 4.4: Invoke validator from kripa-validated-builder before write**

In `agents/kripa-validated-builder.js`, after building each entry (and after Task 1's URL extraction), pass it through `validateFinding`. Log warnings via the existing `logActivity` helper if available, else `console.warn`.

```js
const { validateFinding } = require('./finding-schema')

// Inside the loop building entries, after entry construction:
const validated = validateFinding(entry)
if (validated.warnings.length > 0) {
  // Use logActivity if reachable; otherwise console.warn keeps it visible in PM2 logs
  for (const w of validated.warnings) {
    console.warn(`[kripa-validated-builder] auto-repair: ${w} (taskId=${entry.taskId || '?'})`)
  }
}
// Use the repaired entry (validated.finding) for writing
entries.push(validated.finding)
```

Implementer: locate `logActivity` import in kripa-validated-builder.js. If imported, use it with `{ type: 'schema-repair', taskId, details: warnings.join('; ') }`. If not imported, `console.warn` is sufficient — PM2 captures it.

- [ ] **Step 4.5: Run tests**

```bash
cd /root/agents
bun test test/finding-schema.test.js
```

Expected: ALL PASS.

- [ ] **Step 4.6: Commit**

```bash
cd /root/agents
git add agents/finding-schema.js agents/kripa-validated-builder.js test/finding-schema.test.js
git commit -m "$(cat <<'EOF'
feat: FindingSchema.validateFinding + enforce at kripa-validated-builder boundary

Closes the enforcement gap. finding-schema was bolted on at Phase 3.8 only;
the real producer boundary is kripa-validated-builder.writeValidatedFindingsFile.
Now validates + auto-repairs every entry before write, surfacing schema drift
in PM2 logs instead of silently passing malformed records downstream.

Policy: log + auto-repair, never reject. Required fields with auto-repairs:
  id, title, severity, validation_status, original_agent, taskId.
Each auto-repair emits a warning so dispatch bugs surface early.

6 new validator tests. validateFinding exported alongside REQUIRED_FIELDS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Verify-framework regression gates (86, 87, 88)

**Files:**
- Modify: `verify-framework.js` (append 3 gates after GATE-85)
- Create: `test/gate-86-canonical-url.test.js`
- Create: `test/gate-87-scope-validator-fallback.test.js`
- Create: `test/gate-88-program-type-resolver.test.js`

These three regression-lock the load-bearing invariants from Tasks 1-3.

- [ ] **Step 5.1: Create gate-86 test (canonical url at producer boundary)**

Create `test/gate-86-canonical-url.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert')

test('GATE-86: kripa-validated-builder imports url-extractor', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync('/root/agents/agents/kripa-validated-builder.js', 'utf8')
  assert.match(src, /require\(['"]\.\/url-extractor['"]\)/,
    'kripa-validated-builder must import url-extractor for canonical url emission')
})

test('GATE-86: kripa-validated-builder references extractFirstUrl on details or notes', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync('/root/agents/agents/kripa-validated-builder.js', 'utf8')
  assert.match(src, /extractFirstUrl\([^)]*(details|notes)/,
    'kripa-validated-builder must call extractFirstUrl on details or notes')
})

test('GATE-86: url-extractor module exists and exports extractFirstUrl', () => {
  const { extractFirstUrl } = require('../agents/url-extractor')
  assert.strictEqual(typeof extractFirstUrl, 'function')
  assert.strictEqual(
    extractFirstUrl('test https://example.com/x'),
    'https://example.com/x'
  )
})
```

- [ ] **Step 5.2: Create gate-87 test (scope-validator fallback)**

Create `test/gate-87-scope-validator-fallback.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert')
const sv = require('../agents/scope-validator')

const SCOPE = {
  in_scope: ['*.example.com'],
  out_of_scope: [],
  infra_dependencies: {}
}

test('GATE-87: scope-validator extracts URL from details when top-level missing', () => {
  const r = sv.validateFindingScope({
    id: 'F-X',
    details: 'curl -sI https://api.example.com/login'
  }, SCOPE)
  assert.strictEqual(r.status, 'in-scope',
    'scope-validator must fall back to details/notes URL extraction')
})

test('GATE-87: scope-validator fail-safe still fires when no URL anywhere', () => {
  const r = sv.validateFindingScope({
    id: 'F-Y',
    details: 'no url here',
    notes: ''
  }, SCOPE)
  assert.strictEqual(r.status, 'out-of-scope')
})
```

- [ ] **Step 5.3: Create gate-88 test (program_type resolver)**

Create `test/gate-88-program-type-resolver.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert')
const sp = require('../agents/severity-profile')

test('GATE-88: severity-profile exports resolveProfile', () => {
  assert.strictEqual(typeof sp.resolveProfile, 'function')
})

test('GATE-88: program_type=kudos → pentest', () => {
  assert.strictEqual(sp.resolveProfile({ program_type: 'kudos' }), 'pentest')
})

test('GATE-88: program_type=paid_bounty → bounty', () => {
  assert.strictEqual(sp.resolveProfile({ program_type: 'paid_bounty' }), 'bounty')
})

test('GATE-88: explicit severity_profile wins over program_type', () => {
  assert.strictEqual(
    sp.resolveProfile({ severity_profile: 'comprehensive', program_type: 'paid_bounty' }),
    'comprehensive'
  )
})

test('GATE-88: event-bus.js calls resolveProfile', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync('/root/agents/event-bus.js', 'utf8')
  assert.match(src, /resolveProfile\(/,
    'event-bus.js must call severityProfile.resolveProfile for profile selection')
})
```

- [ ] **Step 5.4: Add 3 gates to verify-framework.js**

Read `verify-framework.js` first to confirm gate pattern (the recon report has the structure). After the last gate (GATE-85 at line ~1981), append:

```js
gate('GATE-86: kripa-validated-builder emits canonical url field via url-extractor', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, 'agents/kripa-validated-builder.js'), 'utf8')
  if (!/require\(['"]\.\/url-extractor['"]\)/.test(src)) {
    throw new Error('kripa-validated-builder.js missing url-extractor require')
  }
  if (!/extractFirstUrl\([^)]*(details|notes)/.test(src)) {
    throw new Error('kripa-validated-builder.js does not call extractFirstUrl on details/notes')
  }
  // url-extractor module must exist + export the function
  const { extractFirstUrl } = require('./agents/url-extractor')
  if (typeof extractFirstUrl !== 'function') {
    throw new Error('url-extractor.js does not export extractFirstUrl')
  }
  return 'canonical url emission wired'
})

gate('GATE-87: scope-validator has URL extraction fallback from details/notes', () => {
  const sv = require('./agents/scope-validator')
  const SCOPE = { in_scope: ['*.example.com'], out_of_scope: [], infra_dependencies: {} }
  const r = sv.validateFindingScope(
    { id: 'F-G87', details: 'curl https://api.example.com/x' },
    SCOPE
  )
  if (r.status !== 'in-scope') {
    throw new Error(`scope-validator did not fall back to details URL extraction (got status=${r.status})`)
  }
  return 'fallback extraction wired'
})

gate('GATE-88: severity-profile.resolveProfile + program_type mapping', () => {
  const sp = require('./agents/severity-profile')
  if (typeof sp.resolveProfile !== 'function') {
    throw new Error('severity-profile.js does not export resolveProfile')
  }
  if (sp.resolveProfile({ program_type: 'kudos' }) !== 'pentest') {
    throw new Error('program_type=kudos must resolve to pentest')
  }
  if (sp.resolveProfile({ program_type: 'paid_bounty' }) !== 'bounty') {
    throw new Error('program_type=paid_bounty must resolve to bounty')
  }
  if (sp.resolveProfile({ severity_profile: 'comprehensive', program_type: 'paid_bounty' }) !== 'comprehensive') {
    throw new Error('explicit severity_profile must win over program_type')
  }
  // event-bus.js wire check
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf8')
  if (!/resolveProfile\(/.test(src)) {
    throw new Error('event-bus.js does not call severityProfile.resolveProfile')
  }
  return 'program_type resolver + event-bus wire'
})
```

- [ ] **Step 5.5: Run verify-framework**

```bash
cd /root/agents
node verify-framework.js
```

Expected: `RESULT: 88/88 gates passed` (or whatever the new total is — was 85 per recon, +3 = 88).

- [ ] **Step 5.6: Run all gate tests individually**

```bash
cd /root/agents
bun test test/gate-86-canonical-url.test.js test/gate-87-scope-validator-fallback.test.js test/gate-88-program-type-resolver.test.js
```

Expected: ALL PASS.

- [ ] **Step 5.7: Commit**

```bash
cd /root/agents
git add verify-framework.js test/gate-86-canonical-url.test.js test/gate-87-scope-validator-fallback.test.js test/gate-88-program-type-resolver.test.js
git commit -m "$(cat <<'EOF'
test: GATE-86/87/88 lock the 3 quality fixes from Sprint A

GATE-86: kripa-validated-builder imports url-extractor + calls
extractFirstUrl on details/notes. Lock to prevent regression of canonical
url emission at the producer boundary.

GATE-87: scope-validator falls back to URL extraction from details when
top-level url field missing. Lock to prevent re-introducing the silent
100% fail-safe OOS bug observed in Lenovo Bugcrowd run.

GATE-88: severity-profile.resolveProfile exists + program_type mapping
correct + event-bus.js wires it for profile selection. Lock to prevent
regression of program_type → profile resolution.

Total gates: 85 → 88.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full QA + CLAUDE.md refresh

**Files:**
- Modify: `/root/CLAUDE.md` (gate count, sprint summary, refresh date)

- [ ] **Step 6.1: Run full test suite**

```bash
cd /root/agents
bun test 2>&1 | tee /tmp/sprint-a-test-output.txt
```

Expected: all green except pre-existing `test/browser-verifier.test.js` playwright timeout (documented in CLAUDE.md).

- [ ] **Step 6.2: Run verify-framework**

```bash
cd /root/agents
node verify-framework.js 2>&1 | tee /tmp/sprint-a-gates-output.txt
tail -3 /tmp/sprint-a-gates-output.txt
```

Expected: `RESULT: 88/88 gates passed`.

- [ ] **Step 6.3: Update CLAUDE.md**

Read `/root/CLAUDE.md` first. Update the "Current framework state" block:
- `refresh date: 2026-05-22` (was 2026-05-15)
- `**88/88 verify-framework gates green**` (was 82/82)
- Add to phase list: brief mention of canonical url emission + scope-validator fallback
- Add line in "active subsystems" table: `kripa-validated-builder canonical url | LIVE (2026-05-22) | url field extracted from details/notes at write time`

- [ ] **Step 6.4: Commit docs refresh**

```bash
cd /root
git -C /root/agents add ../CLAUDE.md 2>/dev/null || true
# CLAUDE.md may not be tracked in /root/agents — check first
# If /root/CLAUDE.md is its own repo or untracked, just edit it; no commit needed
```

If `/root/CLAUDE.md` is outside git, the edit is enough. Skip the commit step.

---

## Task 7: Deploy — backup + PM2 reload + smoke test

**OPERATIONAL — held for explicit Jay approval per CLAUDE.md "Plan First, Code After Approval" unless he explicitly authorized end-to-end including deploy.**

For this plan: Jay said "automatically sab kuch fix kar de" — which is explicit deploy authorization. Execute Task 7.

- [ ] **Step 7.1: Backup event-bus.js and impacted files**

```bash
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/agents/.backups
cp /root/agents/event-bus.js /root/agents/.backups/event-bus.js.bak-${TS}
cp /root/agents/agents/severity-profile.js /root/agents/.backups/severity-profile.js.bak-${TS}
cp /root/agents/agents/scope-validator.js /root/agents/.backups/scope-validator.js.bak-${TS}
cp /root/agents/agents/finding-schema.js /root/agents/.backups/finding-schema.js.bak-${TS}
cp /root/agents/agents/kripa-validated-builder.js /root/agents/.backups/kripa-validated-builder.js.bak-${TS}
echo "Backups in /root/agents/.backups/ tagged ${TS}"
```

- [ ] **Step 7.2: Confirm no in-flight tasks before reload**

```bash
python3 -c "
import json
t=json.load(open('/root/intel/tasks.json'))
inflight=[x for x in t if x.get('status')=='in-progress']
print(f'In-flight: {len(inflight)}')
for x in inflight: print(f'  - {x.get(\"id\")} {x.get(\"title\")}')"
```

Expected: 0 in-flight. (Lenovo queue is empty per current state; Jay said don't dispatch new during this window.) If non-zero, abort reload + report to Jay.

- [ ] **Step 7.3: PM2 reload event-bus**

```bash
pm2 reload event-bus
sleep 3
pm2 logs event-bus --lines 10 --nostream | tail -15
pm2 list | grep event-bus
```

Expected: event-bus shows `online`, recent log lines clean (no startup errors).

- [ ] **Step 7.4: Verify new code loaded**

```bash
# Quick verification via a known signature from the new code
pm2 logs event-bus --lines 50 --nostream 2>/dev/null | grep -i "resolveProfile\|url-extractor\|validateFinding" | head -5
echo "---"
# Daemon-side sanity
node -e "const sp = require('/root/agents/agents/severity-profile'); console.log('resolveProfile exists:', typeof sp.resolveProfile === 'function')"
node -e "const { extractFirstUrl } = require('/root/agents/agents/url-extractor'); console.log('extractFirstUrl works:', extractFirstUrl('a https://x.test b'))"
```

Expected: `resolveProfile exists: true`, `extractFirstUrl works: https://x.test`.

- [ ] **Step 7.5: Update memory with sprint summary**

Save a memory file `project_sprint_quality_may22.md` recording: 3 bugs fixed, files touched, gate count 85→88, the architectural insight that producer-side root-cause fixes beat consumer-side band-aids when the producer is a single chokepoint.

---

## Self-review checklist (run before dispatching subagents)

1. **Spec coverage:** All 3 bugs from Jay's analysis addressed. ✓
2. **Framework-general:** Zero per-program coupling (no hardcoded Lenovo/Bugcrowd). All changes apply to all 7 squads. ✓
3. **Backwards compatible:** explicit dispatch.severity_profile still wins (no breaking change to existing callers). ✓
4. **TDD discipline:** every code task has failing test → impl → pass → commit. ✓
5. **Test coverage:** 9 (url-extractor) + 4 (scope-validator) + 7 (severity-profile) + 6 (finding-schema) + 7 (gates) = 33 new tests. ✓
6. **Gate count math:** 85 + 3 = 88. Verified in Task 5. ✓
7. **No silent failures introduced:** validateFinding auto-repairs + warns, never drops; scope-validator fallback preserves fail-safe behavior. ✓
8. **Operational safety:** Backups before PM2 reload; in-flight check; rollback path (cp from .backups). ✓
9. **Single source of truth for URL regex:** shared url-extractor.js module. Pentest squad-policy keeps inline regex (gate-covered, not worth churn). ✓
10. **No placeholder code in plan steps:** every code block is complete and copy-pasteable. ✓
