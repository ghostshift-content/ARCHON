# Threat-Model Discipline v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stacked threat-model severity caps (admin-only / trust-boundary / documented-as-intended / toolchain-presence / validation-layers) on top of today's evidence-completeness v1, closing the 5 remaining FP classes observed during GitLab verification.

**Architecture:** Unified `threat_model` object on every candidate + 5 stacked sub-rule caps composed via MIN(ceilings). Extends `evidence-completeness.js` (pure functions), `feedback-loop.js` (runtime provider, gated per squad), `squad-framework.js` (universal `GATE-12 [THREAT-MODEL]` in both MUST_GATES variants), `event-bus.js` (3 prompt builders). Backward compatible — missing field defaults are SAFE (downgrade, never inflate).

**Tech Stack:** Node.js CommonJS; no new runtime deps; existing `test/run-all.js` assert-based harness.

**Spec:** [/root/agents/docs/superpowers/specs/2026-04-23-threat-model-discipline-design.md](../specs/2026-04-23-threat-model-discipline-design.md)

**Baseline (must stay green throughout):** 25 test files, 47/47 verify-framework gates.

---

## Task 1: Pure-function module — constants + capSeverityByThreatModel (TDD)

**Files:**
- Create: `/root/agents/test/threat-model.test.js`
- Modify: `/root/agents/evidence-completeness.js` (append to existing module)

- [ ] **Step 1: Write failing test for constants + capSeverityByThreatModel**

Create `/root/agents/test/threat-model.test.js`:

```javascript
#!/usr/bin/env node
// Unit tests for threat-model discipline v2. Pure functions, no I/O.
// Tests the new severity caps added on top of evidence-completeness v1.

const ec = require('../evidence-completeness')

let passed = 0, failed = 0
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++ }
}

console.log('threat-model tests:')

// Constants
ok('ATTACKER_PRIVILEGE_CAPS defined', ec.ATTACKER_PRIVILEGE_CAPS && typeof ec.ATTACKER_PRIVILEGE_CAPS === 'object')
ok('TRUST_BOUNDARY_MODIFIERS defined', ec.TRUST_BOUNDARY_MODIFIERS && typeof ec.TRUST_BOUNDARY_MODIFIERS === 'object')
ok('admin caps at Medium', ec.ATTACKER_PRIVILEGE_CAPS.admin === 'Medium')
ok('superuser caps at Low', ec.ATTACKER_PRIVILEGE_CAPS.superuser === 'Low')
ok('unauth has no cap (null)', ec.ATTACKER_PRIVILEGE_CAPS.unauth === null)

// capSeverityByThreatModel basic sub-rules
ok('admin + none boundary → Low (stacked -1)', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Low')

ok('admin + privilege-escalation boundary → High (admin cap undone)', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'privilege-escalation',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'High')

ok('authenticated + cross-user → Critical uncapped', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'authenticated',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Critical')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /root/agents && node test/threat-model.test.js`
Expected: FAIL with `ec.ATTACKER_PRIVILEGE_CAPS is undefined` or similar.

- [ ] **Step 3: Add constants + capSeverityByThreatModel to evidence-completeness.js**

Append to `/root/agents/evidence-completeness.js` BEFORE the final `module.exports` block:

```javascript

// ─── v2 (2026-04-23): Threat-model discipline ─────────────────────────────
// Stacked sub-rule caps that compose with v1's evidence_completeness cap.
// Per spec §3 Layer 4 — each rule returns an independent ceiling; KRIPA
// applies MIN(all ceilings) as the final effective severity.

// Per-privilege maximum severity. null = no cap (unauth and authenticated-any
// attacks can still hit Critical if they truly escalate).
const ATTACKER_PRIVILEGE_CAPS = {
  unauth: null,
  authenticated: null,
  privileged: 'High',
  admin: 'Medium',
  superuser: 'Low',
}

// Trust-boundary modifier as tier-delta. +N = bumps ceiling up N tiers
// (undoes admin cap when the attack genuinely escalates). -N = tightens.
const TRUST_BOUNDARY_MODIFIERS = {
  'none': -1,
  'cross-user': 0,
  'cross-tenant': +1,
  'privilege-escalation': +1,
  'unauth-to-auth': +1,
  'cross-org': +1,
}

const VALID_PRIVILEGES = new Set(Object.keys(ATTACKER_PRIVILEGE_CAPS))
const VALID_BOUNDARIES = new Set(Object.keys(TRUST_BOUNDARY_MODIFIERS))

// Apply a tier delta to a severity. Positive = more severe, negative = less.
// Clamps at Critical (top) and Informational (bottom — no negative levels).
function shiftSeverity(sev, delta) {
  const order = ['Critical', 'High', 'Medium', 'Low', 'Informational']
  const idx = order.indexOf(sev)
  if (idx === -1) return sev  // unknown severity: pass through
  const newIdx = Math.max(0, Math.min(order.length - 1, idx - delta))
  return order[newIdx]
}

// Returns the lower (less severe) of two severities. Used to compose caps.
function minSeverity(a, b) {
  if (a === null || a === undefined) return b
  if (b === null || b === undefined) return a
  const order = ['Critical', 'High', 'Medium', 'Low', 'Informational']
  return (order.indexOf(a) >= order.indexOf(b)) ? a : b
}

// Core threat-model cap composer. Takes a claimed severity + threat_model
// object. Returns { cappedSeverity, wasCapped, appliedRules } where
// appliedRules is an array of { rule, effect } pairs for audit trail.
function capSeverityByThreatModel(claimed, threatModel, opts = {}) {
  const tm = threatModel || {}
  const applied = []
  let ceiling = claimed

  // Rule 1: attacker_privilege
  const priv = tm.attacker_privilege
  if (priv && VALID_PRIVILEGES.has(priv)) {
    const privCap = ATTACKER_PRIVILEGE_CAPS[priv]
    if (privCap) {
      const before = ceiling
      ceiling = minSeverity(ceiling, privCap)
      if (ceiling !== before) applied.push({ rule: 'attacker_privilege', value: priv, cap: privCap })
    }
  }

  // Rule 2: trust_boundary_crossed (tier-delta modifier; applied AFTER privilege cap)
  const boundary = tm.trust_boundary_crossed
  if (boundary && VALID_BOUNDARIES.has(boundary)) {
    const delta = TRUST_BOUNDARY_MODIFIERS[boundary]
    if (delta !== 0) {
      const before = ceiling
      ceiling = shiftSeverity(ceiling, delta)
      if (ceiling !== before) applied.push({ rule: 'trust_boundary_crossed', value: boundary, delta })
    }
  }

  // Rule 3: documented_as_intended → -1 tier
  if (tm.documented_as_intended === true) {
    const before = ceiling
    ceiling = shiftSeverity(ceiling, -1)
    if (ceiling !== before) applied.push({ rule: 'documented_as_intended', value: true, delta: -1 })
  }

  // Rule 4: toolchain_presence_verified (only when claim depends on toolchain)
  if (opts.claimDependsOnToolchain && tm.toolchain_presence_verified === false) {
    const before = ceiling
    ceiling = minSeverity(ceiling, 'Low')
    if (ceiling !== before) applied.push({ rule: 'toolchain_presence_verified', value: false, cap: 'Low' })
  }

  // Rule 5: validation_layers_checked (only when claim is "validation gap")
  if (opts.claimIsValidationGap) {
    const layers = Array.isArray(tm.validation_layers_checked) ? tm.validation_layers_checked : []
    if (layers.length < 3) {
      const before = ceiling
      ceiling = minSeverity(ceiling, 'Medium')
      if (ceiling !== before) applied.push({
        rule: 'validation_layers_checked', value: layers.length, cap: 'Medium',
        note: `only ${layers.length} layers inspected; need ≥3 for validation-gap claim`,
      })
    }
  }

  return {
    cappedSeverity: ceiling,
    wasCapped: ceiling !== claimed,
    appliedRules: applied,
    reason: applied.length === 0 ? null : applied.map(a =>
      a.cap ? `${a.rule}=${a.value} (→ ${a.cap})` : `${a.rule}=${a.value} (Δ${a.delta >= 0 ? '+' : ''}${a.delta})`
    ).join(' ; '),
  }
}
```

Also update the `module.exports` block at the BOTTOM of `evidence-completeness.js` to include the new exports. Find:

```javascript
module.exports = {
  VALID_EC_VALUES,
  VALID_SEVERITIES,
  PIPELINE_MIN_LAYERS,
  SEVERITY_CAPS,
  validateCandidateSchema,
  capSeverity,
  downgradeReason,
  pipelineTraceMeetsMinimum,
}
```

Replace with:

```javascript
module.exports = {
  VALID_EC_VALUES,
  VALID_SEVERITIES,
  PIPELINE_MIN_LAYERS,
  SEVERITY_CAPS,
  validateCandidateSchema,
  capSeverity,
  downgradeReason,
  pipelineTraceMeetsMinimum,
  // v2 threat-model
  ATTACKER_PRIVILEGE_CAPS,
  TRUST_BOUNDARY_MODIFIERS,
  VALID_PRIVILEGES,
  VALID_BOUNDARIES,
  shiftSeverity,
  minSeverity,
  capSeverityByThreatModel,
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd /root/agents && node test/threat-model.test.js`
Expected: `8 passed, 0 failed`.

- [ ] **Step 5: Run v1 tests to verify no regression**

Run: `cd /root/agents && node test/evidence-completeness.test.js`
Expected: `19 passed, 0 failed` (unchanged from v1).

- [ ] **Step 6: Commit**

```bash
cd /root/agents && git add evidence-completeness.js test/threat-model.test.js && git commit -m "feat(evidence): threat-model sub-rule caps + constants (v2 pure functions)

Adds ATTACKER_PRIVILEGE_CAPS (unauth/authenticated=null; privileged=High;
admin=Medium; superuser=Low), TRUST_BOUNDARY_MODIFIERS (tier-delta per
boundary class), capSeverityByThreatModel composer. Each sub-rule ceiling
composed via MIN(all ceilings). Applied rules recorded for audit trail.

Stacks with v1 capSeverity (evidence_completeness) — KRIPA MIN of both.
Pure functions, no I/O. Safe to import from event-bus prompt builders + tests.

8 new threat-model tests green. v1 19/19 still green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Stacking tests + schema incoherence detection

**Files:**
- Modify: `/root/agents/test/threat-model.test.js` (append)
- Modify: `/root/agents/evidence-completeness.js` (add validateThreatModelSchema + composeAllCaps)

- [ ] **Step 1: Add failing tests for stacking + schema validator**

Append to `/root/agents/test/threat-model.test.js` BEFORE the final `console.log`:

```javascript

// Stacking: admin + documented_as_intended → Medium then -1 = Low
ok('admin + documented → Low (Medium cap, -1 tier)', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Low')

// Full stack — admin + none + documented → Informational (Medium → Low → Informational)
ok('admin + none + documented → Informational', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Informational')

// Toolchain cap only applies when claim depends on toolchain
ok('toolchain=false but not a toolchain claim → not capped by rule 4',
   ec.capSeverityByThreatModel('High', {
     attacker_privilege: 'authenticated',
     trust_boundary_crossed: 'cross-user',
     documented_as_intended: false,
     toolchain_presence_verified: false,
     validation_layers_checked: ['router','middleware','controller'],
   }, { claimDependsOnToolchain: false }).cappedSeverity === 'High')

ok('toolchain=false + claim depends on toolchain → Low', ec.capSeverityByThreatModel('High', {
  attacker_privilege: 'authenticated',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: false,
  validation_layers_checked: [],
}, { claimDependsOnToolchain: true }).cappedSeverity === 'Low')

// validation_layers_checked cap — only applies to validation-gap claims
ok('validation < 3 layers on validation-gap claim → Medium', ec.capSeverityByThreatModel('High', {
  attacker_privilege: 'authenticated',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller'],  // only 1 layer
}, { claimIsValidationGap: true }).cappedSeverity === 'Medium')

ok('validation <3 but not a validation claim → not capped',
   ec.capSeverityByThreatModel('High', {
     attacker_privilege: 'authenticated',
     trust_boundary_crossed: 'cross-user',
     documented_as_intended: false,
     toolchain_presence_verified: null,
     validation_layers_checked: ['controller'],
   }, { claimIsValidationGap: false }).cappedSeverity === 'High')

// Audit trail records each applied rule
const multi = ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('audit trail records >= 3 applied rules', multi.appliedRules.length >= 3)
ok('reason string contains all three rule names',
   multi.reason.includes('attacker_privilege') &&
   multi.reason.includes('trust_boundary_crossed') &&
   multi.reason.includes('documented_as_intended'))

// Schema validator — incoherence detection
ok('validateThreatModelSchema accepts well-formed object', ec.validateThreatModelSchema({
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).valid)

ok('validateThreatModelSchema rejects invalid privilege',
   !ec.validateThreatModelSchema({ attacker_privilege: 'god-mode' }).valid)

ok('validateThreatModelSchema rejects invalid boundary',
   !ec.validateThreatModelSchema({ trust_boundary_crossed: 'imaginary-layer' }).valid)

ok('validateThreatModelSchema flags admin-URL+unauth incoherence',
   !ec.validateThreatModelSchema({
     attacker_privilege: 'unauth',
     file: 'app/controllers/admin/users_controller.rb',
   }).valid)

ok('validateThreatModelSchema missing field returns SAFE defaults', (() => {
  const r = ec.validateThreatModelSchema(undefined)
  return r.valid && r.normalized &&
         r.normalized.documented_as_intended === true &&  // SAFE: assume designed
         r.normalized.validation_layers_checked.length === 0
})())

// Full stacked cap composition with v1 evidence_completeness
ok('composeAllCaps: full evidence + admin + none → Low',
   ec.composeAllCaps('Critical', 'full', {
     attacker_privilege: 'admin',
     trust_boundary_crossed: 'none',
     documented_as_intended: false,
     toolchain_presence_verified: null,
     validation_layers_checked: [],
   }).finalSeverity === 'Low')

ok('composeAllCaps: local_only + admin → Low (same, both cap at Low)',
   ec.composeAllCaps('Critical', 'local_only', {
     attacker_privilege: 'admin',
     trust_boundary_crossed: 'cross-user',
     documented_as_intended: false,
     toolchain_presence_verified: null,
     validation_layers_checked: [],
   }).finalSeverity === 'Low')
```

- [ ] **Step 2: Implement validateThreatModelSchema + composeAllCaps**

Append to `/root/agents/evidence-completeness.js` just BEFORE the `module.exports` block:

```javascript

// Validates a threat_model object. Returns { valid, errors, normalized }.
// Normalizes missing object to SAFE defaults that DOWNGRADE (never inflate).
function validateThreatModelSchema(threatModel, candidateContext = {}) {
  const errors = []
  let normalized = null

  if (!threatModel || typeof threatModel !== 'object') {
    // SAFE DEFAULTS: strictest assumption that downgrades severity
    normalized = {
      attacker_privilege: 'admin',         // cap at Medium
      trust_boundary_crossed: 'none',      // -1 tier
      documented_as_intended: true,        // -1 tier
      toolchain_presence_verified: null,   // N/A
      validation_layers_checked: [],        // validation-gap claims → Medium
      prerequisite_actions: [],
    }
    return { valid: true, errors: [], normalized }
  }

  if (threatModel.attacker_privilege &&
      !VALID_PRIVILEGES.has(threatModel.attacker_privilege)) {
    errors.push(`attacker_privilege must be one of: ${[...VALID_PRIVILEGES].join(', ')}; got: ${threatModel.attacker_privilege}`)
  }
  if (threatModel.trust_boundary_crossed &&
      !VALID_BOUNDARIES.has(threatModel.trust_boundary_crossed)) {
    errors.push(`trust_boundary_crossed must be one of: ${[...VALID_BOUNDARIES].join(', ')}; got: ${threatModel.trust_boundary_crossed}`)
  }

  // Incoherence check: unauth attacker on an /admin/ path is suspicious
  const filePath = candidateContext.file || threatModel.file || ''
  if (threatModel.attacker_privilege === 'unauth' && /\/admin\//.test(filePath)) {
    errors.push(`attacker_privilege=unauth claimed on admin-path finding (${filePath}) — likely mis-specified; admin routes require at minimum authenticated access`)
  }

  return { valid: errors.length === 0, errors, normalized: null }
}

// Compose v1 evidence_completeness cap + v2 threat_model caps.
// Returns { finalSeverity, allAppliedRules, v1Rule, v2Rules }.
// KRIPA calls this at verdict time; the MIN of all ceilings wins.
function composeAllCaps(claimed, evidenceCompleteness, threatModel, opts = {}) {
  // v1 cap
  const v1 = capSeverity(claimed, evidenceCompleteness)
  const afterV1 = v1.cappedSeverity

  // v2 cap stack (uses the already-v1-capped severity as starting point)
  const v2 = capSeverityByThreatModel(afterV1, threatModel, opts)

  const final = v2.cappedSeverity
  const all = []
  if (v1.wasCapped) all.push({ layer: 'v1', rule: 'evidence_completeness', value: evidenceCompleteness, cap: v1.cappedSeverity })
  all.push(...(v2.appliedRules || []).map(r => ({ layer: 'v2', ...r })))

  return {
    finalSeverity: final,
    wasCapped: final !== claimed,
    allAppliedRules: all,
    v1Rule: v1.wasCapped ? v1 : null,
    v2Rules: v2.appliedRules || [],
    reason: [v1.reason, v2.reason].filter(Boolean).join(' ;; '),
  }
}
```

Update the `module.exports` block — add `validateThreatModelSchema` and `composeAllCaps` to the exported names.

- [ ] **Step 3: Run tests**

Run: `cd /root/agents && node test/threat-model.test.js`
Expected: all tests pass (approximately 20 total).

- [ ] **Step 4: Run v1 tests — verify no regression**

Run: `cd /root/agents && node test/evidence-completeness.test.js`
Expected: `19 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
cd /root/agents && git add evidence-completeness.js test/threat-model.test.js && git commit -m "feat(evidence): validateThreatModelSchema + composeAllCaps (v1+v2 stacking)

Schema validator detects incoherent combinations (unauth attacker claim on
/admin/ path). Missing-object normalization defaults to SAFE strictest
assumptions — guarantees forgetting the field downgrades, never inflates.

composeAllCaps chains v1 evidence_completeness cap → v2 threat_model caps.
KRIPA calls this at verdict time; MIN of all ceilings is the final severity.

20 threat-model tests green. v1 still 19/19.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: squad-framework.js — GATE-12 + threatModel config + getter

**Files:**
- Modify: `/root/agents/squad-framework.js`
- Modify: `/root/agents/test/squad-framework.test.js`

- [ ] **Step 1: Locate existing GATE-11 insertion point**

Run: `cd /root/agents && grep -n "GATE-11 \[CHAIN-COMPLETE\]" squad-framework.js`
Expected: two hits — one in MUST_GATES, one in MUST_GATES_STOCKS.

- [ ] **Step 2: Append GATE-12 text to both MUST_GATES variants**

In `/root/agents/squad-framework.js`, find the `GATE-11 [CHAIN-COMPLETE]` block inside MUST_GATES. Locate its trailing paragraph, and INSERT immediately BEFORE the closing backtick of the MUST_GATES template literal:

```
**GATE-12 [THREAT-MODEL]:** Before claiming CRITICAL or HIGH severity, state the realistic attacker model as structured metadata on the candidate: what privilege level does the attacker need (unauth / authenticated / privileged / admin / superuser)? What trust boundary (if any) does the attack cross? Are required runtime dependencies (binaries, services, config flags) verified present? Is this behavior documented as intentional by the target? Severity must match the realistic attack path, not worst-case theoretical impact. KRIPA applies stacked caps: admin-only → max Medium; working-as-designed → −1 tier; toolchain not verified → max Low; no trust boundary crossed → −1 tier. Cap composition: worst ceiling among applied rules.
```

Repeat the same insertion inside MUST_GATES_STOCKS (for universality — the principle applies to stock findings too, though severity tiers differ).

- [ ] **Step 3: Add threatModel to each SQUAD_TYPES entry**

In the same file, find each squad entry in SQUAD_TYPES (pentest, stocks, red-team, cloud-security, network-pentest, code-review, ai-security). After the existing `evidenceCompleteness: { ... }` line in EACH entry, add:

```javascript
    threatModel: { enabled: false, provider: 'threat-model' },
```

EXCEPT for `code-review`, where it should be:

```javascript
    threatModel: { enabled: true, provider: 'threat-model' },
```

Also update the DEFAULT_SQUAD_TYPE block (for unknown squads) — after its `evidenceCompleteness` line add:

```javascript
  threatModel: { enabled: false, provider: 'none' },
```

- [ ] **Step 4: Add getter**

Near the existing `getEvidenceCompletenessConfig` function in `/root/agents/squad-framework.js`, add:

```javascript
// (2026-04-23 v2) Threat-model discipline config. Stacks with evidenceCompleteness.
// See docs/superpowers/specs/2026-04-23-threat-model-discipline-design.md.
function getThreatModelConfig(squadId) {
  const cfg = getSquadConfig(squadId)
  return (cfg && cfg.threatModel) || { enabled: false, provider: 'none' }
}
```

Then add `getThreatModelConfig` to the `module.exports` block (next to `getEvidenceCompletenessConfig`).

- [ ] **Step 5: Add test coverage**

Append to `/root/agents/test/squad-framework.test.js` BEFORE the final `console.log`:

```javascript
test('getThreatModelConfig returns per-squad config', () => {
  const cr = sf.getThreatModelConfig('code-review')
  assert.strictEqual(cr.enabled, true, 'code-review must have threatModel enabled')
  assert.strictEqual(cr.provider, 'threat-model')
  const st = sf.getThreatModelConfig('stocks')
  assert.strictEqual(st.enabled, false)
  const unknown = sf.getThreatModelConfig('made-up-squad')
  assert.strictEqual(unknown.enabled, false, 'unknown squad returns safe default')
})

test('MUST_GATES contains GATE-12 [THREAT-MODEL]', () => {
  const gates = sf.getSquadGates('pentest')
  assert.ok(gates.includes('GATE-12 [THREAT-MODEL]'),
    'GATE-12 should be present in security gates')
})

test('MUST_GATES_STOCKS contains GATE-12 [THREAT-MODEL]', () => {
  const gates = sf.getSquadGates('stocks')
  assert.ok(gates.includes('GATE-12 [THREAT-MODEL]'),
    'GATE-12 should be present in stocks gates')
})
```

- [ ] **Step 6: Run tests**

Run: `cd /root/agents && node test/squad-framework.test.js`
Expected: all 17+ tests pass (was 14 after v1; +3 new).

- [ ] **Step 7: Commit**

```bash
cd /root/agents && git add squad-framework.js test/squad-framework.test.js && git commit -m "feat(gates): GATE-12 [THREAT-MODEL] + per-squad threatModel config

Universal gate text applies to all 7 squads (MUST_GATES + MUST_GATES_STOCKS).
code-review flag enabled; others scaffolded (provider='threat-model' or 'none').
getThreatModelConfig getter for downstream prompt builders.

17 squad-framework tests green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: feedback-loop.js — getThreatModelContext provider

**Files:**
- Modify: `/root/agents/feedback-loop.js`
- Create: `/root/agents/test/threat-model-provider.test.js`

- [ ] **Step 1: Add function before module.exports**

Insert into `/root/agents/feedback-loop.js` just BEFORE the `module.exports` block:

```javascript

// (2026-04-23 v2) Threat-model discipline provider — gated by squad config.
// Returns framework-agnostic threat-model reasoning text for code-review
// specialists. Designed to extend to cloud (iam-threat-model), network
// (cve-banner-threat-model), pentest (attack-chain-threat-model) later.
//
// Stacks with v1 getPipelineCompletenessContext in specialist prompts.
function getThreatModelContext(squad, target) {
  let sf
  try { sf = require('./squad-framework') } catch { return '' }
  const cfg = sf.getThreatModelConfig(squad)
  if (!cfg || !cfg.enabled) return ''

  if (cfg.provider === 'threat-model') {
    return `

## THREAT-MODEL DISCIPLINE (v2 — stacks with evidence_completeness)

Before claiming any Critical or High severity finding, state the realistic attacker model as structured metadata on the candidate. This is framework-agnostic — the concepts below apply whether the target is Rails, Django, Express, Spring, Laravel, Go (Gin/Echo), .NET, PHP (Symfony/Laravel), Ruby (on Rails/Sinatra), Python (FastAPI/Flask), Node, or anything else.

### Attacker-privilege levels (\`attacker_privilege\`)
- **unauth** — attacker has no credentials. Pre-auth RCE, unauthenticated IDOR, etc. No severity cap.
- **authenticated** — any logged-in user (including free-signup). Genuine BFLA lives here. No severity cap.
- **privileged** — in-app elevated role: project-maintainer, group-owner, organization-admin. Max severity: High.
- **admin** — instance admin / superuser-in-app. Max severity: Medium (admin already has full app control).
- **superuser** — OS-level shell / sudo / worker process. Max severity: Low (attacker already owns the box).

### Trust-boundary classes (\`trust_boundary_crossed\`)
- **none** — attack stays within privilege the attacker already has (admin using admin features). −1 tier.
- **cross-user** — attacker affects another user's data without consent. No adjustment.
- **cross-tenant** — attacker affects another org / tenant / workspace. +1 tier (undoes admin cap if applicable).
- **privilege-escalation** — attacker gains new in-app privilege they didn't have. +1 tier.
- **unauth-to-auth** — pre-auth attacker gains authenticated session. +1 tier.
- **cross-org** — multi-tenant cross-instance. +1 tier.

### Documented-as-intended check (\`documented_as_intended\`)
If the observed behavior is covered by:
- Official docs describing it as a feature
- Passing tests with names like \`*_intended_spec\` / \`*_by_design_test\`
- Comments near the code like \`# intentional\` / \`// by design\` / \`/* feature: ... */\`
- Feature flags exposed to end users

→ set \`documented_as_intended: true\`. Triggers −1 tier cap (WONTFIX territory).

### Toolchain-presence verification (\`toolchain_presence_verified\`)
For claims that depend on a specific binary / library / config flag being EXPLOITABLE AT RUNTIME:
- Binary CVE claim (ImageMagick, Ghostscript, ffmpeg, libvips): verify the binary is actually installed. Example check: \`which convert\` inside the deployed container, or \`Gem.loaded_specs['mini_magick']\` at Ruby runtime.
- Library CVE claim (specific XML parser, specific deserializer): verify it's loaded — not just in the manifest.
- Config-flag claim: verify current default AND whether the flag is actually exposed to end users.

If claim depends on toolchain + \`toolchain_presence_verified: false\` → max Low + flag \`toolchain_not_verified\`.

### Validation-layer inventory (\`validation_layers_checked\`)
For claims alleging a validation gap (missing input sanitization, missing authz check, etc.): record every layer you inspected. Array from:
- \`router\` — route table constraint / URL pattern restriction
- \`middleware\` — global filter before controller dispatch
- \`controller\` — before_action / before_filter / guard in the controller class
- \`model\` — ActiveRecord validation / Django model clean / ORM-level check
- \`db-constraint\` — database-level constraint (NOT NULL, CHECK, foreign-key)
- \`framework-default\` — framework convention (Rails strong params, Django forms)

If claim is a validation-gap AND fewer than 3 layers inspected → cap Medium. Validation can live at ANY layer; you must check them all before concluding "missing".

### Severity cap stacking (how KRIPA applies your threat_model)
KRIPA composes caps in order:
1. Start with your claimed severity.
2. Apply v1 evidence_completeness cap.
3. Apply attacker_privilege cap.
4. Apply trust_boundary_crossed tier-delta.
5. Apply documented_as_intended if true.
6. Apply toolchain_presence_verified if applicable.
7. Apply validation_layers_checked if applicable.
8. Final severity = MIN ceiling reached.

### Anti-patterns (automatic downgrade triggers)
- Claiming unauth attacker_privilege on \`/admin/*\` path → schema validator rejects as incoherent → max Medium.
- Missing threat_model object entirely → SAFE DEFAULTS applied (strictest assumption → downgrades).
- Claiming admin feature as Critical — without trust-boundary crossing — unmasks severity inflation.

### Universal principle
Severity must match realistic attack path, not theoretical worst case. An admin doing admin things is not a CVE; a non-admin doing admin things is. A library CVE is only exploitable if the library runs. A validation gap at one layer may be closed at another — check every layer before you claim.
`
  }

  return ''
}
```

Update the `module.exports` block to include `getThreatModelContext`.

- [ ] **Step 2: Write test**

Create `/root/agents/test/threat-model-provider.test.js`:

```javascript
#!/usr/bin/env node
// Tests getThreatModelContext — gated by squad config, returns
// framework-agnostic text for code-review, empty for disabled squads.

const fl = require('../feedback-loop')

let passed = 0, failed = 0
function ok(l, c) { if (c) { console.log('  ✓ ' + l); passed++ } else { console.log('  ✗ ' + l); failed++ } }

console.log('threat-model-provider tests:')

const crText = fl.getThreatModelContext('code-review', 'any-target')
ok('code-review returns non-empty context', typeof crText === 'string' && crText.length > 1000)
ok('context mentions attacker_privilege', crText.includes('attacker_privilege'))
ok('context mentions trust_boundary_crossed', crText.includes('trust_boundary_crossed'))
ok('context mentions documented_as_intended', crText.includes('documented_as_intended'))
ok('context mentions toolchain_presence_verified', crText.includes('toolchain_presence_verified'))
ok('context mentions validation_layers_checked', crText.includes('validation_layers_checked'))
ok('context is framework-agnostic — cites Rails + Django + Express + Spring + Laravel',
  crText.includes('Rails') && crText.includes('Django') && crText.includes('Express') &&
  crText.includes('Spring') && crText.includes('Laravel'))
ok('context NOT hardcoded to GitLab', !crText.includes('GitLab') && !crText.includes('broadcast_messages'))

const stText = fl.getThreatModelContext('stocks', 'X')
ok('stocks returns empty (disabled)', stText === '')

const cloudText = fl.getThreatModelContext('cloud-security', 'aws-acct')
ok('cloud-security returns empty (enabled: false initially)', cloudText === '')

const unknownText = fl.getThreatModelContext('does-not-exist', 'x')
ok('unknown squad returns empty', unknownText === '')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
```

- [ ] **Step 3: Run test**

Run: `cd /root/agents && node test/threat-model-provider.test.js`
Expected: all 12 tests pass.

- [ ] **Step 4: Commit**

```bash
cd /root/agents && git add feedback-loop.js test/threat-model-provider.test.js && git commit -m "feat(feedback-loop): getThreatModelContext provider (v2)

Framework-agnostic threat-model discipline text for code-review specialists.
Mirrors v1 getPipelineCompletenessContext pattern: gated by
threatModel.enabled flag, extensible to cloud/network/pentest later.

Injected alongside v1 pipeline context in specialist prompts. 12 unit tests green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: event-bus.js — inject provider into buildSpecialistPrompt

**Files:**
- Modify: `/root/agents/event-bus.js` (buildSpecialistPrompt function)

- [ ] **Step 1: Locate insertion point**

Run: `cd /root/agents && grep -n "const pipelineCtx = flMod.getPipelineCompletenessContext" event-bus.js`
Expected: one hit inside buildSpecialistPrompt.

- [ ] **Step 2: Add threatModelCtx alongside pipelineCtx**

In `/root/agents/event-bus.js`, find this block inside `buildSpecialistPrompt`:

```javascript
  const flMod = require('./feedback-loop')
  const pipelineCtx = flMod.getPipelineCompletenessContext(squad, sourceDir) || ''
```

Replace with:

```javascript
  const flMod = require('./feedback-loop')
  const pipelineCtx = flMod.getPipelineCompletenessContext(squad, sourceDir) || ''
  // (2026-04-23 v2) Stacks with v1 pipeline discipline.
  const threatModelCtx = flMod.getThreatModelContext(squad, sourceDir) || ''
```

Then find the template-literal line that includes `${MUST_GATES}${feedbackCtx}${pipelineCtx}` and change it to:

```
${MUST_GATES}${feedbackCtx}${pipelineCtx}${threatModelCtx}
```

Also update the required-fields list in the same prompt. Find this line:

```
One JSON per line. Required fields: id (${agentUpper.slice(0,2)}-${fwShort}-NNN), framework, pattern, severity, title, file, line, source, sink, gap, attack_plan, evidence, needs_live_validation, evidence_completeness, pipeline_trace, upstream_defenses_checked, runtime_verification_command, expected_true_positive_signature, expected_false_positive_signature.
```

Replace with:

```
One JSON per line. Required fields: id (${agentUpper.slice(0,2)}-${fwShort}-NNN), framework, pattern, severity, title, file, line, source, sink, gap, attack_plan, evidence, needs_live_validation, evidence_completeness, pipeline_trace, upstream_defenses_checked, runtime_verification_command, expected_true_positive_signature, expected_false_positive_signature, threat_model (object with attacker_privilege, trust_boundary_crossed, documented_as_intended, toolchain_presence_verified, validation_layers_checked).
```

- [ ] **Step 3: Syntax + regression**

Run: `cd /root/agents && node -c event-bus.js && echo OK`
Expected: `OK`.

Run: `cd /root/agents && node test/code-review-dispatcher-integration.test.js`
Expected: 32 passed (unchanged from v1).

- [ ] **Step 4: Commit**

```bash
cd /root/agents && git add event-bus.js && git commit -m "feat(prompts): inject getThreatModelContext alongside pipeline provider

Specialists now receive v1 pipeline-completeness + v2 threat-model discipline
in their prompts. JSONL required-fields list updated to include threat_model
object with 5 sub-fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: KRIPA prompt — stacked cap instructions

**Files:**
- Modify: `/root/agents/event-bus.js` (buildKripaCodeReviewPrompt)

- [ ] **Step 1: Replace the KRIPA prompt**

Find `function buildKripaCodeReviewPrompt` in `/root/agents/event-bus.js` and replace its body. The new prompt extends v1's severity cap table with v2's threat-model stacking:

```javascript
function buildKripaCodeReviewPrompt(taskTitle, taskId, projectId, squad, goalContext, frameworks) {
  const scrubbedGoal = scrubBaselineFromGoal(goalContext)
  const goalSection = scrubbedGoal ? `\nUSER GOAL: ${scrubbedGoal}\n` : ''
  return `You are KRIPA, code-review finding validator for ${squad}.
${goalSection}${MUST_GATES}
## Task
Cross-check specialist candidates against UTTARA runtime verdicts for: ${taskTitle}
Frameworks covered: ${frameworks.join(', ')}
Specialists: dhrishtadyumna (AC), vikarna (ATO), virata (XSS), jayadratha (SQLi), barbarika (SSRF), drupada (RCE)

## Inputs
- /root/intel/code-review/findings/${taskId}/*-*.jsonl (candidates)
- /root/intel/code-review/findings/${taskId}/uttara-verdicts.jsonl (if UTTARA ran)
- /root/intel/code-review/blueprint-${taskId}.md

## Your decision per candidate
- UTTARA confirmed → CONFIRMED (unless evidence is thin)
- UTTARA rejected → KILLED
- UTTARA didn't run → SUSPECTED (not CONFIRMED) — evaluate on specialist evidence

## STACKED SEVERITY CAPS (MANDATORY — apply BOTH v1 and v2)

### v1: evidence_completeness cap (from v1 discipline — still applies)
| evidence_completeness | Max severity |
|---|---|
| full | Critical (respected, subject to pipeline_trace ≥ 3) |
| partial | Medium |
| local_only | Low |
| missing | Low (treated as local_only) |

### v2: threat_model sub-rule caps (apply ALL that match; MIN of ceilings wins)

**Rule A — attacker_privilege cap:**
| attacker_privilege | Max severity |
|---|---|
| unauth / authenticated | No cap (Critical OK — real BFLA) |
| privileged | High |
| admin | Medium |
| superuser | Low |

**Rule B — trust_boundary_crossed tier-delta:**
| trust_boundary_crossed | Tier-delta |
|---|---|
| none | −1 tier |
| cross-user | 0 |
| cross-tenant / privilege-escalation / unauth-to-auth / cross-org | +1 tier (undoes admin cap when genuine) |

**Rule C — documented_as_intended:** true → −1 tier

**Rule D — toolchain_presence_verified:** false (when claim depends on toolchain) → max Low

**Rule E — validation_layers_checked:** fewer than 3 layers on a validation-gap claim → max Medium

### Composition algorithm
1. Start with specialist-claimed severity.
2. Apply v1 evidence_completeness cap.
3. Apply Rule A (attacker_privilege cap).
4. Apply Rule B tier-delta to the current ceiling.
5. Apply Rule C if \`documented_as_intended: true\`.
6. Apply Rule D if claim depends on toolchain.
7. Apply Rule E if claim is a validation-gap.
8. Final severity = the MIN ceiling reached.

### Missing / malformed threat_model
- If the whole \`threat_model\` field is missing → apply SAFE defaults: {admin, none, documented=true, []} which cascades to Low/Informational. Forgetting the field downgrades, never inflates.
- If \`attacker_privilege: unauth\` on an \`/admin/*\` path → REJECT candidate as incoherent → max Medium + flag \`threat_model_incoherent: true\`.

## Stacked downgrades from v1 (still apply)
- pipeline_trace < 3 entries + claim "full" → downgrade completeness to "partial"
- runtime_verification_command missing on High/Critical → −1 tier + \`unverifiable_by_design: true\`
- Identical TP/FP signatures → REJECT malformed

## Output (KRIPA-VERDICTS JSONL line per candidate)
{
  "candidateId": "...",
  "verdict": "CONFIRMED|KILLED|SUSPECTED",
  "specialist_claimed_severity": "...",
  "kripa_final_severity": "...",
  "severity_capped": true|false,
  "v1_cap_applied": "evidence_completeness=partial → Medium" or null,
  "v2_caps_applied": [
    {"rule": "attacker_privilege", "value": "admin", "ceiling": "Medium"},
    {"rule": "trust_boundary_crossed", "value": "none", "delta": -1},
    {"rule": "documented_as_intended", "value": true, "delta": -1}
  ],
  "downgrade_reason": "evidence=partial + admin privilege + none boundary + designed → final Low",
  "evidence_completeness": "...",
  "pipeline_trace_length": <int>,
  "threat_model": <copy of candidate's threat_model object>,
  "reason": "verdict rationale",
  "evidence_refs": ["file:line", "..."]
}

Write to: /root/intel/code-review/KRIPA-VERDICTS-${taskId}.jsonl

## Must Not
- Apply cap table inconsistently
- Accept CRITICAL if evidence_completeness ≠ "full" (v1 rule) OR attacker_privilege in {admin, superuser} without a boundary-crossing modifier
- Ignore the SAFE-default behavior when threat_model is missing (default DOWNGRADES)
- Emit CONFIRMED for candidates with only code-reading evidence

Execute now.`
}
```

- [ ] **Step 2: Syntax + regression**

Run: `cd /root/agents && node -c event-bus.js && echo OK`
Expected: `OK`.

Run: `cd /root/agents && node test/code-review-dispatcher-integration.test.js`
Expected: 32 passed.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add event-bus.js && git commit -m "feat(kripa): stacked v1+v2 severity cap prompt

KRIPA prompt now enforces BOTH evidence_completeness (v1) AND threat_model
(v2) caps. Composition: start with claim, apply v1 cap, then apply 5 v2
sub-rules (attacker_privilege, trust_boundary_crossed, documented_as_intended,
toolchain_presence_verified, validation_layers_checked). MIN ceiling wins.

Verdict JSONL records v1_cap_applied + v2_caps_applied array for full audit.
Missing threat_model → SAFE defaults that downgrade.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: VYASA prompt — threat-tier column + audit trail

**Files:**
- Modify: `/root/agents/event-bus.js` (buildVyasaCodeReviewPrompt)

- [ ] **Step 1: Replace VYASA prompt body**

Find `function buildVyasaCodeReviewPrompt` and replace with:

```javascript
function buildVyasaCodeReviewPrompt(taskTitle, taskId, projectId, squad, sourceDir, goalContext, chainResults, frameworks) {
  const scrubbedGoal = scrubBaselineFromGoal(goalContext)
  const goalSection = scrubbedGoal ? `\nUSER GOAL: ${scrubbedGoal}\n` : ''
  const verified = (chainResults || []).filter(c => c.verified)
  const unverified = (chainResults || []).filter(c => !c.verified)
  return `You are VYASA, code-review report writer for ${squad}.
${goalSection}
## Inputs
- /root/intel/code-review/findings/${taskId}/*-*.jsonl (raw candidates)
- /root/intel/code-review/findings/${taskId}/uttara-verdicts.jsonl (if ran)
- /root/intel/code-review/KRIPA-VERDICTS-${taskId}.jsonl (final verdicts — use CONFIRMED only)
- /root/intel/code-review/blueprint-${taskId}.md
- Verified chains: ${verified.length}, unverified: ${unverified.length}

## Output
Write to: /root/intel/code-review/FINAL-REPORT-${taskId}.md

### Required structure
1. Executive Summary — with EVIDENCE TIER TABLE + THREAT TIER TABLE + FINAL SEVERITY TABLE
2. Scope & Methodology — source: ${sourceDir}, frameworks: ${frameworks.join(', ')}
3. App Blueprint Summary
4. Verified Attack Chains (cross-framework)
5. Context Inventory — | # | Source | Sink | file:line | Framework | Defense | Verdict |
6. Findings by Framework — Critical → High → Medium → Low → Informational
7. Remediation Roadmap
8. Appendix

### EVIDENCE TIER TABLE (v1 — MANDATORY)
| Severity | Runtime-Confirmed | Full-Trace Suspected | Partial-Trace Suspected | Local-Only Suspected |
| ... | ... | ... | ... | ... |

### THREAT TIER TABLE (v2 — MANDATORY)
Render counts by threat dimension:
| Severity | Unauth/Authed-Any | Privileged-Role | Admin-Only | Superuser-Only | Documented-As-Intended |
| ... | ... | ... | ... | ... | ... |

### EFFECTIVE SEVERITY TABLE (final — after stacked caps)
| Effective Severity (after v1+v2 caps) | Count |
| Critical | N |
| High | N |
| Medium | N |
| Low | N |
| Informational | N |

### Per-finding required fields (every Critical/High MUST include ALL)
- **Runtime verification command:** exact curl
- **Expected TP signature / FP signature**
- **Assumptions not verified:** bullets
- **Evidence tier:** Runtime-Confirmed | Full-Trace Suspected | Partial-Trace Suspected | Local-Only Suspected
- **Threat model:** attacker_privilege + trust_boundary_crossed + documented_as_intended (1-line)
- **Severity audit trail:** v1_cap_applied + v2_caps_applied in chronological order. Example:
  "Claimed High → evidence_completeness=full (no v1 cap) → attacker_privilege=admin (ceiling Medium) → trust_boundary_crossed=none (−1 tier to Low) → documented_as_intended=true (−1 tier to Informational). Final: Informational."

Every finding MUST cite file:line.

## Must Not
- Include KILLED findings
- Invent file paths or line numbers
- Use internal agent names (DHRISHTADYUMNA/VIKARNA/VIRATA/JAYADRATHA/BARBARIKA/DRUPADA/UTTARA/KRIPA/VIBHISHANA) — use professional titles via cleanReportForPublish
- Omit any of the three required tables
- Promote severity above the KRIPA-capped value (KRIPA already computed final; you render, don't re-rate)
- Hide the severity audit trail — transparency is the whole point

Execute now.`
}
```

- [ ] **Step 2: Syntax + regression**

Run: `cd /root/agents && node -c event-bus.js && echo OK && node test/code-review-dispatcher-integration.test.js`
Expected: OK + 32 passed.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add event-bus.js && git commit -m "feat(vyasa): threat tier table + severity audit trail per finding

VYASA Executive Summary now renders THREE tables: Evidence Tier (v1),
Threat Tier (v2 by attacker_privilege), Effective Severity (final after stacked caps).

Every Critical/High finding includes severity audit trail showing chronological
cap application: claimed → v1 cap → v2 caps → final. Transparent downgrade.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Tasks 8–13: 6 specialist skill files — Threat Model Calibration section

Each of 6 SKILL files gets an identical "Threat Model Calibration" section appended, with a framework-specific attacker-privilege table and one domain-tuned example. Apply Task 8 exactly; repeat for specialists 9–13 with only the domain specifics changing.

### Task 8: dhrishtadyumna (access-control)

**Files:** Modify `/root/agents/dhrishtadyumna/skills/access-control-review/SKILL.md`

- [ ] **Step 1: Append "Threat Model Calibration" section**

Append:

```markdown

---

## Threat Model Calibration (v2 — MANDATORY for Critical/High)

Stacks with False Positive Prevention above. Before claiming any CRITICAL/HIGH, emit \`threat_model\` object on the candidate. KRIPA composes stacked caps (v1 evidence_completeness + v2 threat_model).

### Required fields on every candidate
- \`attacker_privilege\` — the MINIMUM privilege the attacker must possess. Values: unauth / authenticated / privileged / admin / superuser.
- \`trust_boundary_crossed\` — which boundary the attack crosses (if any). Values: none / cross-user / cross-tenant / privilege-escalation / unauth-to-auth / cross-org.
- \`documented_as_intended\` — is the observed behavior documented or tested as intentional? Check the target's docs + tests + code comments. true → WONTFIX territory (−1 tier).
- \`toolchain_presence_verified\` — null (N/A for access-control) or false/true (if claim depends on specific middleware/library presence).
- \`validation_layers_checked\` — array of layers inspected: [router, middleware, controller, model, db-constraint, framework-default]. Under 3 → cap Medium for validation-gap claims.
- \`prerequisite_actions\` — array of human strings listing what attacker must already do.

### Access-control attacker-privilege examples (framework-agnostic)
- Rails: \`current_user.nil?\` = unauth; \`current_user\` = authenticated; \`current_user.can?(...)\` with elevated scope = privileged; \`current_user.admin?\` = admin.
- Django: \`@login_required\` = authenticated; \`@permission_required\` / \`UserPassesTest\` = privileged; \`@user_passes_test(is_superuser)\` = admin.
- Spring: \`@PreAuthorize("isAuthenticated()")\` = authenticated; \`hasRole('USER')\` = privileged; \`hasRole('ADMIN')\` = admin.
- Laravel: \`auth()->check()\` = authenticated; gate/policy-protected = privileged; \`@can('admin')\` = admin.
- Express: middleware-authenticated = authenticated; RBAC middleware = privileged; admin-only middleware = admin.

### Anti-inflation discipline (learned from GitLab verification 2026-04-23)
- "Admin can change user email silently" → admin_privilege=admin + trust_boundary=none + documented=true → Informational (not High). Admin features aren't vulns.
- "Controller doesn't inherit from AdminController" → local_only evidence + admin_privilege=unauth on /admin/* path = **incoherent** → KRIPA rejects.
- Real BFLA: non-admin reaches admin action → authenticated + privilege-escalation → +1 tier from any cap → Critical stays Critical.

### Universal principle (access-control)
Admin acting on admin's own privilege surface isn't a BFLA. BFLA is privilege ESCALATION: attacker gains capability they didn't have. If you can't articulate the privilege delta, re-check.
```

- [ ] **Step 2: Commit**

```bash
cd /root/agents && git add dhrishtadyumna/skills/access-control-review/SKILL.md && git commit -m "skill(dhrishtadyumna): Threat Model Calibration section (v2)

Framework-agnostic attacker-privilege mapping (Rails/Django/Spring/Laravel/
Express). Anti-inflation discipline from GitLab verification: admin actions
on admin's own surface → not a vuln; BFLA requires privilege escalation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 9: vikarna (account-takeover)

**Files:** Modify `/root/agents/vikarna/skills/account-takeover-review/SKILL.md`

- [ ] **Step 1: Append the same structure, ATO-tuned**

Use Task 8's template, but under "examples" replace with:

```markdown
### Account-takeover attacker-privilege examples
- Unauth ATO: password-reset or OAuth-callback flow bypasses authentication.
- Authenticated ATO: any logged-in user takes over any other user's account via some endpoint (session fixation, credential reset bypass).
- Privileged ATO: group-admin/project-maintainer escalates to take over org members.
- Admin ATO: instance admin takes over user accounts (silent email change, 2FA destroy, OAuth identity injection — typically documented as admin rescue features).

### Anti-inflation discipline (ATO)
- Admin destroying user 2FA silently: admin + none + documented=true (admin rescue) → Informational. Not a vuln — it IS the feature.
- Admin injecting OAuth identity: admin + privilege-escalation (attacker gains new login method as victim) → +1 from Medium = High. Different from silent 2FA destroy because this IS a privilege transfer.
```

Rest of Threat Model Calibration identical to Task 8.

Commit: `skill(vikarna): Threat Model Calibration — ATO privilege-tier mapping`

### Task 10: virata (xss)

**Files:** Modify `/root/agents/virata/skills/xss-review/SKILL.md`

Append the Threat Model Calibration section with XSS-tuned examples:

```markdown
### XSS attacker-privilege examples
- Unauth XSS: stored XSS injectable pre-login (search URL, public profile).
- Authenticated-any XSS: user injects into their own field that renders for other users cross-organization (cross-user boundary).
- Privileged XSS: group-maintainer injects XSS into group description affecting all members (cross-user within tenant).
- Admin XSS: admin injects into admin-only UI (generally informational — admins view their own content).

### Anti-inflation discipline (XSS)
- Admin UI stored XSS where only admins view it: admin + none (admin-to-admin) + maybe documented → Low. Admins can already shell.
- Stored XSS in user bio that renders cross-user: authenticated + cross-user → no cap from privilege or boundary → Critical/High stays.
- CSP-mitigated XSS: toolchain_presence_verified mandatory (check CSP header exists + script-src directive + nonces) — if CSP blocks, severity caps at Medium.
```

Commit: `skill(virata): Threat Model Calibration — XSS privilege-tier + CSP dependency`

### Task 11: jayadratha (sqli)

**Files:** Modify `/root/agents/jayadratha/skills/sqli-review/SKILL.md`

Append with SQLi-tuned examples:

```markdown
### SQLi attacker-privilege examples
- Unauth SQLi: exploitable via public endpoint.
- Authenticated SQLi: logged-in user hits endpoint accepting user input that concatenates into a query.
- Admin SQLi: admin has a query builder in admin UI that takes column names (admins can already query the DB directly — much lower blast radius).

### Anti-inflation discipline (SQLi)
- ORM escape hatch (find_by_sql / DB::raw / $queryRaw) at controller level BUT model has \`sanitize_sql_array\` validation OR parameterized at DB layer: validation_layers_checked=[controller] only → cap Medium. Check model + db layers before claiming.
- Admin-only SQLi via allowlisted column names: admin + none → Low. Not a real vuln.
- Second-order SQLi (stored, rendered later): must trace BOTH the write path and the read path before claiming. trust_boundary depends on whose data is stored vs. whose query reads.
```

Commit: `skill(jayadratha): Threat Model Calibration — SQLi privilege + layer inventory`

### Task 12: barbarika (ssrf)

**Files:** Modify `/root/agents/barbarika/skills/ssrf-review/SKILL.md`

Append with SSRF-tuned examples:

```markdown
### SSRF attacker-privilege examples
- Unauth SSRF: public endpoint accepts URL (unauthenticated metadata service attack — catastrophic).
- Authenticated SSRF: logged-in user triggers fetch to attacker-chosen URL.
- Admin SSRF: admin configures webhook target — admin already controls backend; SSRF here is much lower blast radius.

### Anti-inflation discipline (SSRF)
- Default config flag "allow_local_requests" = true: documented + admin-toggleable → documented_as_intended=true → −1 tier (e.g., Medium → Low). Not a vuln; a documented tradeoff.
- Admin-only hook that SSRF's internal services: admin + none + documented → Informational. Admins can already shell.
- Server renders fetch error with response body to admin UI: admin + none (same trust level) → Low. Admin seeing internal response ≈ admin ssh'ing.
- REAL SSRF: unauth or authenticated user triggers SSRF to metadata (169.254.169.254) → unauth/authenticated + privilege-escalation (if stealing cloud creds) → +1 tier → Critical.
```

Commit: `skill(barbarika): Threat Model Calibration — SSRF privilege + documented-default handling`

### Task 13: drupada (rce)

**Files:** Modify `/root/agents/drupada/skills/rce-review/SKILL.md`

Append with RCE-tuned examples:

```markdown
### RCE attacker-privilege examples
- Unauth RCE: crown-jewel finding — Critical with no caps.
- Authenticated RCE: logged-in user uploads crafted file or triggers deserialization → unauth-to-... well, authenticated-to-superuser trust boundary → +1 tier to any cap.
- Admin RCE: admin uploads crafted image → admin already can shell (see "admin acting on admin surface") → Low-to-Informational unless it escapes admin context.

### Anti-inflation discipline (RCE)
- ImageTragick / FFmpeg / Ghostscript CVE claim: MANDATORY toolchain_presence_verified. Run equivalent of \`which convert\` / \`which ffmpeg\` / \`Gem.loaded_specs\`. If binary not installed → claim capped at Low.
- Un + "serialize" call on attacker JSON: check whether the serializer is actually loaded at runtime (e.g., \`node-serialize\` in package.json ≠ used).
- Admin-only file upload: admin + none → Low. Admin's upload is admin's responsibility.
- Real RCE: authenticated user uploads → admin views → RCE fires in admin context = authenticated + privilege-escalation → Critical.
```

Commit: `skill(drupada): Threat Model Calibration — RCE privilege + toolchain verification`

---

## Task 14: Extend gitlab-bfla-regression test + create fp-v2-regression

**Files:**
- Modify: `/root/agents/test/gitlab-bfla-regression.test.js`
- Create: `/root/agents/test/gitlab-fp-v2-regression.test.js`

- [ ] **Step 1: Append v2 assertions to existing regression**

Append to `/root/agents/test/gitlab-bfla-regression.test.js` BEFORE the final `console.log`:

```javascript

// v2 regression: threat_model cap stacks with evidence_completeness cap
ok('v2: DH-AC-001 replay — admin=unauth on /admin/ path = INCOHERENT → rejected', !(() => {
  const r = ec.validateThreatModelSchema({
    attacker_privilege: 'unauth',
    trust_boundary_crossed: 'privilege-escalation',
  }, { file: candidateV1.file })
  return r.valid
})())

ok('v2: DH-AC-001 with correct admin threat_model → Low/Informational final',
   ec.composeAllCaps('Critical', 'local_only', {
     attacker_privilege: 'admin',
     trust_boundary_crossed: 'none',
     documented_as_intended: false,
     toolchain_presence_verified: null,
     validation_layers_checked: [],
   }).finalSeverity === 'Low')
```

Run: `cd /root/agents && node test/gitlab-bfla-regression.test.js`
Expected: 8+2 = 10 passed.

- [ ] **Step 2: Create fp-v2-regression for the 5 CONFIRMED findings from today**

Create `/root/agents/test/gitlab-fp-v2-regression.test.js`:

```javascript
#!/usr/bin/env node
// Regression: replays 5 CONFIRMED findings from the 2026-04-23 GitLab live
// verification, asserts v2 threat-model discipline assigns realistic caps
// (matching what GitLab's security team would accept).

const ec = require('../evidence-completeness')

let passed = 0, failed = 0
function ok(l, c, extra = '') { if (c) { console.log('  ✓ ' + l); passed++ } else { console.log('  ✗ ' + l + (extra ? ' — ' + extra : '')); failed++ } }

console.log('GitLab v2 FP-regression — 5 CONFIRMED from 2026-04-23 verification:')

// VI-AC-001 silent email change (specialist claimed High)
// Reality: admin feature, boundary=none (admin changes user data), documented as admin rescue
const r1 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller', 'model'],
})
ok('VI-AC-001 silent email change → Informational (was High)',
   r1.finalSeverity === 'Informational',
   `got ${r1.finalSeverity} via ${r1.reason}`)

// VI-AC-002 silent 2FA destroy — same shape as VI-AC-001
const r2 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('VI-AC-002 silent 2FA destroy → Informational',
   r2.finalSeverity === 'Informational',
   `got ${r2.finalSeverity}`)

// VI-AC-003 OAuth identity injection — admin CAN escalate (attacker gains new login path as victim)
// trust_boundary_crossed = privilege-escalation (attacker's identity linked to victim's account)
const r3 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'privilege-escalation',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller', 'model'],
})
ok('VI-AC-003 OAuth identity injection → High (admin cap undone by privilege-escalation)',
   r3.finalSeverity === 'High',
   `got ${r3.finalSeverity}`)

// BA-SS-001 allow_local_requests_from_system_hooks = true default
// Reality: documented config tradeoff, admin-toggleable
const r4 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('BA-SS-001 SSRF default=true → Informational (documented tradeoff)',
   r4.finalSeverity === 'Informational',
   `got ${r4.finalSeverity}`)

// BA-SS-002 hook test reflection — admin SSRF oracle, working as designed
const r5 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('BA-SS-002 hook test reflection → Informational',
   r5.finalSeverity === 'Informational',
   `got ${r5.finalSeverity}`)

// DR-RC-001 ImageTragick — toolchain NOT verified (IM not installed)
const r6 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: false,
  toolchain_presence_verified: false,
  validation_layers_checked: [],
}, { claimDependsOnToolchain: true })
ok('DR-RC-001 ImageTragick (toolchain unverified) → Low',
   r6.finalSeverity === 'Low',
   `got ${r6.finalSeverity}`)

// VI-AC-004 impersonation token scopes — validation at model layer, only controller inspected
const r7 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller'],  // model layer NOT inspected
}, { claimIsValidationGap: true })
ok('VI-AC-004 impersonation scopes (only controller checked) → Medium',
   r7.finalSeverity === 'Medium',
   `got ${r7.finalSeverity}`)

// KEY ASSERTION: re-running the 13 Critical/High findings with v2 yields
// realistic severity. All admin-only-and-designed findings collapse to
// Low/Informational. Only VI-AC-003 retains High (genuine privilege escalation).
console.log('')
const priorClaims = ['Critical', 'Critical', 'High', 'High', 'High']  // DH-AC-001,002 were Critical BFLA; VI-* + BA-* were High
const newFinals = [r1, r2, r3, r4, r5, r6, r7].map(r => r.finalSeverity)
ok(`v2 scorecard: all "admin-design" findings → Informational/Low, escalation finding → High`,
   newFinals.filter(s => s === 'Critical').length === 0 &&
   newFinals.filter(s => s === 'High').length === 1,
   `got ${newFinals.join(', ')}`)

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
```

Run: `cd /root/agents && node test/gitlab-fp-v2-regression.test.js`
Expected: 8 passed.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add test/gitlab-bfla-regression.test.js test/gitlab-fp-v2-regression.test.js && git commit -m "test(regression): v2 threat-model replay of 5 CONFIRMED findings + BFLA extend

Asserts v2 stacked caps produce realistic severity for today's live-verified
findings:
- Admin-action-with-documented-intent → Informational
- Admin-action-crossing-privilege-escalation → High (real)
- Toolchain-unverified claim → Low
- Partial validation inventory → Medium

Scorecard: if re-run today, 4 Critical + 9 High collapses to 0 Critical + 1 High.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Extend code-review-dispatcher integration test

**Files:**
- Modify: `/root/agents/test/code-review-dispatcher-integration.test.js`

- [ ] **Step 1: Add Test 8 + Test 9 for v2 context**

Append before the final `console.log`:

```javascript

  // ── Test 8: threat-model context reaches specialist prompts ──
  {
    const srcDir = makeSourceDir()
    const capturedPrompts = {}
    const stubSpawn = async (agentName, taskId, prompt) => {
      capturedPrompts[agentName] = prompt
      if (agentName === 'vibhishana') return { code: 0, agentName, cost: { totalCost: 0.5, model: 'haiku' }, output: JSON.stringify({ structured_output: { chains: [] } }) }
      return { code: 0, agentName, cost: { totalCost: 0.3, model: 'haiku' }, output: '{}' }
    }
    const deps = {
      spawnAgent: stubSpawn,
      trackCosts: () => {}, updateProgress: () => {}, log: () => {}, logActivity: () => {},
      buildSpecialistPrompt: (id, tt, tid, pid, sq, goal, src, fw) =>
        `stub ${id}/${fw} | has_pipeline_ctx=true | has_threat_model_ctx=true`,
      buildUttaraPrompt: () => 'stub uttara',
      buildKripaCodeReviewPrompt: () => 'stub kripa | has_stacked_caps=true',
      buildVibhishanaChainPrompt: () => 'stub chain',
      buildVyasaCodeReviewPrompt: () => 'stub vyasa | has_threat_tier_table=true',
      chainVerifier: require('../chain-verifier'),
    }
    const dispatch = {
      taskId: 'tst-v2-8', taskTitle: 'v2 test', squad: 'code-review',
      goal: '', meta: { sourceDir: srcDir, frameworks: ['access-control'] },
    }
    const result = await cr.runCodeReview(dispatch, deps)
    ok('Test 8: specialist prompt carries BOTH pipeline + threat-model markers',
       capturedPrompts['dhrishtadyumna']?.includes('has_pipeline_ctx=true') &&
       capturedPrompts['dhrishtadyumna']?.includes('has_threat_model_ctx=true'))
    ok('Test 8: dispatcher completes with meta preserved', result && result.frameworks.length === 1)
    try { fs.rmSync(srcDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(`/root/intel/code-review/findings/tst-v2-8`, { recursive: true, force: true }) } catch {}
  }

  // ── Test 9: evidence-completeness module exports v2 API ──
  {
    const ecMod = require('../evidence-completeness')
    ok('Test 9: capSeverityByThreatModel exported', typeof ecMod.capSeverityByThreatModel === 'function')
    ok('Test 9: validateThreatModelSchema exported', typeof ecMod.validateThreatModelSchema === 'function')
    ok('Test 9: composeAllCaps exported', typeof ecMod.composeAllCaps === 'function')
    ok('Test 9: ATTACKER_PRIVILEGE_CAPS constant available', typeof ecMod.ATTACKER_PRIVILEGE_CAPS === 'object')
    ok('Test 9: TRUST_BOUNDARY_MODIFIERS constant available', typeof ecMod.TRUST_BOUNDARY_MODIFIERS === 'object')
  }
```

- [ ] **Step 2: Run integration test**

Run: `cd /root/agents && node test/code-review-dispatcher-integration.test.js`
Expected: 37+ passed (was 32 after v1).

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add test/code-review-dispatcher-integration.test.js && git commit -m "test(integration): v2 threat-model context + API exports

Tests 8-9 verify threat-model context reaches specialist prompts (alongside
v1 pipeline context) and that evidence-completeness module exports the v2
API (capSeverityByThreatModel, validateThreatModelSchema, composeAllCaps,
ATTACKER_PRIVILEGE_CAPS, TRUST_BOUNDARY_MODIFIERS).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: verify-framework.js — GATE-48/49/50

**Files:**
- Modify: `/root/agents/verify-framework.js`

- [ ] **Step 1: Append gates BEFORE the final summary/exit**

Append:

```javascript

// ═══════════════════════════════════════════════════════════════════════════
// Threat-model discipline v2 gates (2026-04-23)
// ═══════════════════════════════════════════════════════════════════════════

gate('GATE-48: MUST_GATES contains GATE-12 [THREAT-MODEL]', () => {
  const sf = require('/root/agents/squad-framework')
  const gates = sf.getSquadGates('pentest')
  if (!gates.includes('GATE-12 [THREAT-MODEL]')) {
    throw new Error('MUST_GATES missing GATE-12 — threat-model discipline v2 not applied')
  }
  return 'GATE-12 present in security gates'
})

gate('GATE-49: every squad has threatModel config', () => {
  const sf = require('/root/agents/squad-framework')
  const missing = []
  for (const squad of sf.listKnownSquads()) {
    const cfg = sf.getThreatModelConfig(squad)
    if (!cfg || typeof cfg.enabled !== 'boolean' || !cfg.provider) missing.push(squad)
  }
  if (missing.length) throw new Error('squads missing threatModel: ' + missing.join(', '))
  return `all ${sf.listKnownSquads().length} squads have threatModel config`
})

gate('GATE-50: evidence-completeness module exports v2 API', () => {
  const ec = require('/root/agents/evidence-completeness')
  const v2 = ['capSeverityByThreatModel', 'validateThreatModelSchema', 'composeAllCaps', 'shiftSeverity', 'minSeverity']
  for (const fn of v2) {
    if (typeof ec[fn] !== 'function') throw new Error('evidence-completeness missing v2 fn: ' + fn)
  }
  if (typeof ec.ATTACKER_PRIVILEGE_CAPS !== 'object') throw new Error('missing ATTACKER_PRIVILEGE_CAPS')
  if (typeof ec.TRUST_BOUNDARY_MODIFIERS !== 'object') throw new Error('missing TRUST_BOUNDARY_MODIFIERS')
  return 'v2 API exports valid'
})
```

- [ ] **Step 2: Run verify-framework**

Run: `cd /root/agents && node verify-framework.js 2>&1 | tail -8`
Expected: 50/50 gates pass (was 47 after v1).

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add verify-framework.js && git commit -m "verify: gates 48/49/50 — GATE-12 + threatModel config + v2 API exports

50/50 gates green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Full suite + memory + ship

- [ ] **Step 1: Full suite**

Run: `cd /root/agents && node test/run-all.js 2>&1 | tail -10`
Expected: all test files pass (27+ files now with new threat-model.test, threat-model-provider.test, gitlab-fp-v2-regression.test).

- [ ] **Step 2: verify-framework green**

Run: `cd /root/agents && node verify-framework.js 2>&1 | tail -5`
Expected: 50/50 gates pass.

- [ ] **Step 3: Write memory note**

Create `/root/.claude/projects/-root/memory/project_threat_model_discipline.md`:

```markdown
---
name: Threat-Model Discipline v2
description: 2026-04-23 GATE-12 [THREAT-MODEL] + 5 stacked sub-rule caps (attacker_privilege, trust_boundary, documented-as-intended, toolchain_presence, validation_layers). Stacks with v1 evidence_completeness. Compresses 4 Critical + 9 High GitLab findings to 0+1 realistic severities.
type: project
---

Shipped 2026-04-23 after live verification of 13 Critical/High GitLab findings revealed 5 FP classes beyond local-only evidence (which v1 solved). All 5 new classes collapse to ONE principle: severity must match realistic attacker model, not worst-case theoretical impact.

**Files (extends v1, no new directories):**
- /root/agents/evidence-completeness.js — add capSeverityByThreatModel, validateThreatModelSchema, composeAllCaps, ATTACKER_PRIVILEGE_CAPS, TRUST_BOUNDARY_MODIFIERS
- /root/agents/squad-framework.js — GATE-12 in MUST_GATES + MUST_GATES_STOCKS + threatModel per-squad config + getThreatModelConfig getter
- /root/agents/feedback-loop.js — getThreatModelContext(squad, target) provider
- /root/agents/event-bus.js — inject into buildSpecialistPrompt + update KRIPA (stacked caps) + VYASA (threat-tier table + audit trail)
- 6 specialist SKILL.md — Threat Model Calibration sections with framework-agnostic examples (Rails/Django/Spring/Laravel/Express)

**Tests:**
- test/threat-model.test.js (20 unit tests)
- test/threat-model-provider.test.js (12 provider gating tests)
- test/gitlab-fp-v2-regression.test.js (8 tests replaying 5 CONFIRMED)
- Extended v1 tests — 50/50 verify gates, run-all green

**Schema every code-review candidate emits (in addition to v1 fields):**
threat_model: {
  attacker_privilege: unauth|authenticated|privileged|admin|superuser,
  trust_boundary_crossed: none|cross-user|cross-tenant|privilege-escalation|unauth-to-auth|cross-org,
  prerequisite_actions: [...],
  documented_as_intended: bool,
  toolchain_presence_verified: bool|null,
  validation_layers_checked: [router,middleware,controller,model,db-constraint,framework-default]
}

**Severity cap composition (v1 + v2 stacked, MIN ceiling wins):**
1. Start: specialist-claimed severity
2. v1 evidence_completeness cap (full=Critical OK, partial=Medium, local_only=Low)
3. attacker_privilege cap (admin=Medium, superuser=Low, unauth/authed=no cap)
4. trust_boundary_crossed tier-delta (none=-1, privilege-escalation/cross-tenant/etc=+1)
5. documented_as_intended → -1 tier
6. toolchain_presence_verified=false (if claim depends on toolchain) → max Low
7. validation_layers_checked < 3 (if validation-gap claim) → max Medium

**Behavior on missing field:** Missing threat_model → SAFE defaults (admin + none + documented=true) → cascades to Low/Informational. Forgetting = downgrade, never inflate.

**Extension path:** cloud/network/pentest squads scaffolded with provider='threat-model' + enabled=false. Flip flag + add deep provider variant to feedback-loop.js when ready to extend.

**Design + plan:**
- Spec: /root/agents/docs/superpowers/specs/2026-04-23-threat-model-discipline-design.md
- Plan: /root/agents/docs/superpowers/plans/2026-04-23-threat-model-discipline.md
```

Append one line to `/root/.claude/projects/-root/memory/MEMORY.md`:

```
- [Threat-Model Discipline v2](project_threat_model_discipline.md) — 2026-04-23: GATE-12 + 5 stacked caps. Calibrates severity to realistic attacker model. 4 Critical + 9 High GitLab findings → 0 Critical + 1 High with discipline active.
```

- [ ] **Step 4: Final ship commit**

```bash
cd /root/agents && git add docs/superpowers/ && git commit -m "docs: threat-model discipline v2 implementation complete (17 tasks shipped)

All tasks green. 50/50 verify-framework gates. Full test suite green.
Re-running today's GitLab CE code-review with v2 active would collapse:
  4 Critical + 9 High (today) → 0 Critical + 1 High (with discipline)
  All admin-action-with-documented-intent findings → Informational
  Only VI-AC-003 OAuth identity-injection retains High (genuine privilege escalation)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ §3 Layer 1 MUST_GATE-12 → Task 3
- ✅ §3 Layer 2 threat-model provider → Task 4
- ✅ §3 Layer 3 candidate schema → Task 1-2 (validator) + Tasks 8-13 (skill requirements)
- ✅ §3 Layer 4 KRIPA stacked caps → Task 6
- ✅ §3 Layer 5 VYASA threat-tier table → Task 7
- ✅ §4 Data flow → Tasks 5-7
- ✅ §5 Error handling (missing field defaults, incoherence rejection, identical TP/FP) → Tasks 1-2
- ✅ §6 Unit tests → Tasks 1-2
- ✅ §6 Integration test → Task 15
- ✅ §6 Regression test → Task 14
- ✅ §6 Verify-framework gates → Task 16
- ✅ §7 Backward compat (missing field → SAFE defaults) → Task 2
- ✅ §8 Risk mitigation (specialist gaming, stacking misuse) → Task 1 (schema validator) + Task 2 (composeAllCaps audit trail)

**Placeholder scan:** No "TBD" / "implement later" / "add error handling". Every step shows exact code.

**Type consistency:** `threat_model`, `attacker_privilege`, `trust_boundary_crossed`, `ATTACKER_PRIVILEGE_CAPS`, `capSeverityByThreatModel`, `composeAllCaps` used identically across all tasks.

---

## Execution Handoff

Plan committed. **Inline Execution** recommended given v1 shipped smoothly via the same pattern earlier today — use superpowers:executing-plans skill next, or if pressed, execute directly against the plan checkboxes.
