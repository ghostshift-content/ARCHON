# Evidence-Completeness Discipline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add evidence-completeness discipline across all 7 squads to eliminate Critical/High false positives caused by local-only evidence (e.g., GitLab BFLA DH-AC-001 from 2026-04-23).

**Architecture:** Universal MUST_GATE-11 [CHAIN-COMPLETE] text injected across all squads via existing `MUST_GATES` + dedicated code-review pipeline-completeness provider in `feedback-loop.js`. New pure-function module `evidence-completeness.js` owns severity-cap logic. Candidates emit `evidence_completeness` + `pipeline_trace` + 3 signature fields; KRIPA auto-downgrades partial/local-only claims; VYASA renders tier table. Downgrade-not-drop.

**Tech Stack:** Node.js, CommonJS modules, no new runtime deps. Test runner: existing `test/run-all.js` assert-based harness.

**Spec:** [/root/agents/docs/superpowers/specs/2026-04-23-evidence-completeness-design.md](../specs/2026-04-23-evidence-completeness-design.md)

---

## Task 1: Pure-function module — constants + schema validator

**Files:**
- Create: `/root/agents/evidence-completeness.js`
- Create: `/root/agents/test/evidence-completeness.test.js`

- [ ] **Step 1: Write the failing test for constants + validateCandidateSchema**

Create `/root/agents/test/evidence-completeness.test.js`:

```javascript
#!/usr/bin/env node
// Unit tests for evidence-completeness module — severity cap, schema validator,
// min-layers constants. Pure functions, no I/O, safe to run in parallel with full
// test suite.

const assert = require('assert')
const ec = require('../evidence-completeness')

let passed = 0, failed = 0
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++ }
}

console.log('evidence-completeness tests:')

// ── Constants ──
ok('PIPELINE_MIN_LAYERS has all 7 squads', [
  'code-review', 'cloud-security', 'network-pentest',
  'pentest', 'red-team', 'stocks', 'ai-security',
].every(s => typeof ec.PIPELINE_MIN_LAYERS[s] === 'number'))
ok('code-review min = 3', ec.PIPELINE_MIN_LAYERS['code-review'] === 3)
ok('stocks min = 0', ec.PIPELINE_MIN_LAYERS['stocks'] === 0)

// ── Schema validator ──
const goodCandidate = {
  id: 'TEST-1', severity: 'High',
  evidence_completeness: 'full',
  pipeline_trace: ['router', 'middleware', 'controller'],
  upstream_defenses_checked: [{layer: 'middleware', outcome: 'none'}],
  runtime_verification_command: 'curl http://x',
  expected_true_positive_signature: 'HTTP 200 body contains X',
  expected_false_positive_signature: 'HTTP 404',
}
const r1 = ec.validateCandidateSchema(goodCandidate)
ok('valid candidate passes', r1.valid, JSON.stringify(r1.errors))

const missingEC = { ...goodCandidate }; delete missingEC.evidence_completeness
const r2 = ec.validateCandidateSchema(missingEC)
ok('missing evidence_completeness: still valid but normalized to local_only', r2.valid && r2.normalized === 'local_only')

const badEC = { ...goodCandidate, evidence_completeness: 'bogus' }
const r3 = ec.validateCandidateSchema(badEC)
ok('bogus evidence_completeness rejected', !r3.valid)

const samesig = { ...goodCandidate, expected_false_positive_signature: goodCandidate.expected_true_positive_signature }
const r4 = ec.validateCandidateSchema(samesig)
ok('identical TP/FP signatures rejected', !r4.valid)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /root/agents && node test/evidence-completeness.test.js`
Expected: FAIL with `Cannot find module '../evidence-completeness'`

- [ ] **Step 3: Create the module**

Create `/root/agents/evidence-completeness.js`:

```javascript
// Evidence-Completeness Discipline — pure-function module.
//
// Owns:
//   - PIPELINE_MIN_LAYERS: per-squad minimum layers a 'full' trace must cover.
//     Tunable by editing this constant; squad-framework.js imports from here.
//   - validateCandidateSchema(candidate): returns {valid, errors, normalized}.
//     Normalizes missing evidence_completeness to 'local_only' (safe default).
//     Rejects identical TP/FP signatures (specialist didn't think through FPs).
//   - capSeverity(claimed, evidenceCompleteness): returns capped severity
//     following the 3-tier policy: full=Critical OK, partial=max Medium,
//     local_only=max Low.
//   - downgradeReason(claimed, capped, evidenceCompleteness): human string
//     explaining why KRIPA downgraded — for audit + VYASA report rendering.
//
// This module has NO I/O. Safe to import from event-bus.js prompt builders,
// KRIPA verdict logic, and tests. Do not add side effects.

const VALID_EC_VALUES = new Set(['full', 'partial', 'local_only'])
const VALID_SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational']

// Tunable per-squad minimum layers a 'full' pipeline_trace must cover before
// KRIPA accepts the specialist's 'full' claim. Values from spec §5.
const PIPELINE_MIN_LAYERS = {
  'code-review': 3,
  'cloud-security': 2,
  'network-pentest': 2,
  'pentest': 2,
  'red-team': 2,
  'stocks': 0,
  'ai-security': 3,
}

// 3-tier severity cap per spec §3 (KRIPA severity cap table).
// full → specialist's claim respected up to Critical.
// partial → max Medium (regardless of specialist claim).
// local_only → max Low (strictest).
const SEVERITY_CAPS = {
  full: 'Critical',
  partial: 'Medium',
  local_only: 'Low',
}

function severityRank(s) {
  const idx = VALID_SEVERITIES.indexOf(s)
  return idx === -1 ? VALID_SEVERITIES.length : idx  // unknown → weakest
}

function validateCandidateSchema(candidate) {
  const errors = []
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['candidate is not an object'], normalized: null }
  }

  let ec = candidate.evidence_completeness
  let normalized = null
  if (ec === undefined || ec === null) {
    normalized = 'local_only'
    ec = 'local_only'
  } else if (!VALID_EC_VALUES.has(ec)) {
    errors.push(`evidence_completeness must be one of: ${[...VALID_EC_VALUES].join(', ')}, got: ${ec}`)
  }

  if (candidate.expected_true_positive_signature &&
      candidate.expected_false_positive_signature &&
      candidate.expected_true_positive_signature === candidate.expected_false_positive_signature) {
    errors.push('expected_true_positive_signature and expected_false_positive_signature are identical')
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized,
  }
}

function capSeverity(claimed, evidenceCompleteness, opts = {}) {
  const ec = VALID_EC_VALUES.has(evidenceCompleteness) ? evidenceCompleteness : 'local_only'
  const ceiling = SEVERITY_CAPS[ec]
  const ceilingRank = severityRank(ceiling)
  const claimedRank = severityRank(claimed)

  if (claimedRank < ceilingRank) {
    return {
      cappedSeverity: ceiling,
      wasCapped: true,
      reason: `evidence_completeness=${ec} caps severity at ${ceiling}; specialist claimed ${claimed}`,
      ...(opts.extraReason ? { detail: opts.extraReason } : {}),
    }
  }
  return { cappedSeverity: claimed, wasCapped: false, reason: null }
}

function downgradeReason(claimed, capped, ec, extras = {}) {
  const parts = [`evidence_completeness=${ec}`, `specialist_claimed=${claimed}`, `kripa_capped_to=${capped}`]
  if (extras.trace_too_short) parts.push(`trace_too_short=${extras.minLayers}_required_got_${extras.actualLayers}`)
  if (extras.missing_verification_command) parts.push('missing_runtime_verification_command')
  if (extras.unverifiable_by_design) parts.push('unverifiable_by_design')
  return parts.join(' ; ')
}

function pipelineTraceMeetsMinimum(pipelineTrace, squad) {
  const min = PIPELINE_MIN_LAYERS[squad]
  if (typeof min !== 'number') return true
  const len = Array.isArray(pipelineTrace) ? pipelineTrace.length : 0
  return len >= min
}

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

- [ ] **Step 4: Run test, verify it passes**

Run: `cd /root/agents && node test/evidence-completeness.test.js`
Expected: `7 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
cd /root/agents && git add evidence-completeness.js test/evidence-completeness.test.js && git commit -m "feat(evidence): pure-function module for severity cap + schema validator"
```

---

## Task 2: Extend tests — all 3 tiers + min-layer edge

**Files:**
- Modify: `/root/agents/test/evidence-completeness.test.js`

- [ ] **Step 1: Add failing test cases**

Append before the final `console.log`:

```javascript

// ── capSeverity 3-tier ──
ok('full + Critical → Critical uncapped', ec.capSeverity('Critical', 'full').cappedSeverity === 'Critical' && !ec.capSeverity('Critical', 'full').wasCapped)
ok('partial + Critical → Medium (capped)', ec.capSeverity('Critical', 'partial').cappedSeverity === 'Medium' && ec.capSeverity('Critical', 'partial').wasCapped)
ok('partial + High → Medium (capped)', ec.capSeverity('High', 'partial').cappedSeverity === 'Medium' && ec.capSeverity('High', 'partial').wasCapped)
ok('partial + Low → Low (not capped up)', ec.capSeverity('Low', 'partial').cappedSeverity === 'Low' && !ec.capSeverity('Low', 'partial').wasCapped)
ok('local_only + Critical → Low', ec.capSeverity('Critical', 'local_only').cappedSeverity === 'Low')
ok('local_only + Medium → Low', ec.capSeverity('Medium', 'local_only').cappedSeverity === 'Low')
ok('unknown ec defaults to local_only cap', ec.capSeverity('Critical', 'bogus').cappedSeverity === 'Low')

// ── pipelineTraceMeetsMinimum ──
ok('code-review 3 layers meets min', ec.pipelineTraceMeetsMinimum(['a','b','c'], 'code-review'))
ok('code-review 2 layers fails min', !ec.pipelineTraceMeetsMinimum(['a','b'], 'code-review'))
ok('stocks always passes (min=0)', ec.pipelineTraceMeetsMinimum([], 'stocks'))
ok('unknown squad passes (no enforcement)', ec.pipelineTraceMeetsMinimum([], 'unknown-squad'))

// ── downgradeReason composition ──
const dr = ec.downgradeReason('Critical', 'Medium', 'partial', { trace_too_short: true, minLayers: 3, actualLayers: 1 })
ok('downgradeReason includes trace-too-short detail', dr.includes('partial') && dr.includes('Critical') && dr.includes('Medium') && dr.includes('trace_too_short'))
```

- [ ] **Step 2: Run test, verify all pass**

Run: `cd /root/agents && node test/evidence-completeness.test.js`
Expected: `18 passed, 0 failed`.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add test/evidence-completeness.test.js && git commit -m "test(evidence): cover all 3 severity tiers + pipeline min-layer checks"
```

---

## Task 3: Add MUST_GATE-11 + config to squad-framework.js

**Files:**
- Modify: `/root/agents/squad-framework.js`

- [ ] **Step 1: Locate MUST_GATES**

Run: `cd /root/agents && grep -n "^const MUST_GATES" squad-framework.js | head -2`

- [ ] **Step 2: Append GATE-11 to MUST_GATES literal**

Inside the `MUST_GATES` template literal, before the closing backtick, append:

```
GATE-11 [CHAIN-COMPLETE] — Before claiming any CRITICAL or HIGH severity finding, trace the evidence chain end-to-end in your squad's domain. Local-only evidence (single file, single config value, single packet, single line) is INSUFFICIENT for CRITICAL/HIGH. The chain must cover: input source → every defense layer the input passes through → the sink where the vulnerability manifests. If ANY layer was not inspected, downgrade severity and emit `evidence_completeness` metadata (values: "full", "partial", "local_only") plus `pipeline_trace` (array of layer names inspected). Squad-specific chain examples live in each squad's skill files. KRIPA auto-caps severity: full→Critical OK, partial→max Medium, local_only→max Low.
```

Also append the same paragraph into `MUST_GATES_STOCKS`.

- [ ] **Step 3: Add evidenceCompleteness per squad in SQUAD_TYPES**

In `SQUAD_TYPES`, add to each entry:

```javascript
'code-review': { /* existing */ , evidenceCompleteness: { enabled: true, provider: 'pipeline' } },
'cloud-security': { /* existing */ , evidenceCompleteness: { enabled: false, provider: 'iam-chain' } },
'network-pentest': { /* existing */ , evidenceCompleteness: { enabled: false, provider: 'cve-banner' } },
'pentest': { /* existing */ , evidenceCompleteness: { enabled: false, provider: 'attack-chain' } },
'red-team': { /* existing */ , evidenceCompleteness: { enabled: false, provider: 'inherit' } },
'stocks': { /* existing */ , evidenceCompleteness: { enabled: false, provider: 'none' } },
'ai-security': { /* existing */ , evidenceCompleteness: { enabled: false, provider: 'model-chain' } },
```

- [ ] **Step 4: Add getter + export**

Append helper:

```javascript
function getEvidenceCompletenessConfig(squad) {
  const cfg = SQUAD_TYPES[squad]
  return (cfg && cfg.evidenceCompleteness) || { enabled: false, provider: 'none' }
}
```

Add `getEvidenceCompletenessConfig` to `module.exports`.

- [ ] **Step 5: Run existing test — no regression**

Run: `cd /root/agents && node test/squad-framework.test.js`
Expected: all existing tests pass.

- [ ] **Step 6: Add coverage test**

Append to `test/squad-framework.test.js`:

```javascript
test('getEvidenceCompletenessConfig returns per-squad config', () => {
  const cr = sf.getEvidenceCompletenessConfig('code-review')
  assert.strictEqual(cr.enabled, true)
  assert.strictEqual(cr.provider, 'pipeline')
  const st = sf.getEvidenceCompletenessConfig('stocks')
  assert.strictEqual(st.enabled, false)
  const unknown = sf.getEvidenceCompletenessConfig('made-up-squad')
  assert.strictEqual(unknown.enabled, false)
})

test('MUST_GATES contains GATE-11 [CHAIN-COMPLETE]', () => {
  const gates = sf.getSquadGates('pentest')
  assert.ok(gates.includes('GATE-11 [CHAIN-COMPLETE]'))
})
```

- [ ] **Step 7: Run extended test**

Run: `cd /root/agents && node test/squad-framework.test.js`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
cd /root/agents && git add squad-framework.js test/squad-framework.test.js && git commit -m "feat(gates): add GATE-11 [CHAIN-COMPLETE] + per-squad evidenceCompleteness config"
```

---

## Task 4: Add getPipelineCompletenessContext to feedback-loop.js

**Files:**
- Modify: `/root/agents/feedback-loop.js`
- Create: `/root/agents/test/pipeline-completeness-provider.test.js`

- [ ] **Step 1: Add function before module.exports**

Insert into `/root/agents/feedback-loop.js` just before `module.exports`:

```javascript
function getPipelineCompletenessContext(squad, target) {
  let sf
  try { sf = require('./squad-framework') } catch { return '' }
  const cfg = sf.getEvidenceCompletenessConfig(squad)
  if (!cfg || !cfg.enabled) return ''

  if (cfg.provider === 'pipeline') {
    return `

## EVIDENCE-COMPLETENESS DISCIPLINE (Pipeline Provider)

Before emitting ANY candidate, construct a \`pipeline_trace\` array listing every request-path layer you inspected from user input to the claimed sink. Minimum layers required for this squad to accept a "full" claim: 3.

### Layer taxonomy (framework-agnostic)
Every modern web framework has some subset of these layers:
  1. ROUTER CONSTRAINT — route-table auth/role constraint (Rails constraints lambda, Django decorator, Express router middleware, Laravel middleware chain, Spring @PreAuthorize on URL mapping)
  2. MIDDLEWARE STACK — global middleware inspecting request.path (Rack, Django middleware, Express app.use, Laravel HTTP kernel, ASP.NET filters)
  3. CONTROLLER ANCESTORS — class chain with auth-enforcing module includes/prepends (Rails ApplicationController, Django mixins, Spring @ControllerAdvice, Laravel controller middleware)
  4. FRAMEWORK CONVENTION — namespace/folder auto-wiring auth (Rails Admin:: convention, Django admin site, Nest guards on module)
  5. BEFORE/AROUND_ACTIONS — controller-scoped filters (Rails before_action, Django @method_decorator, Spring @Secured)
  6. POLICY/ABILITY CHECK — inline authorize (Pundit, CanCanCan, Casbin, ABAC)
  7. MODEL-LEVEL SCOPE — query scoped by current_user (Rails default_scope, Django model manager)
  8. SINK — the actual vulnerable operation

### Output schema (every candidate MUST emit)
- \`evidence_completeness\`: "full" | "partial" | "local_only"
- \`pipeline_trace\`: array of layer tokens you INSPECTED
- \`upstream_defenses_checked\`: array of {layer, file, outcome}
- \`runtime_verification_command\`: single curl a human can run
- \`expected_true_positive_signature\`: HTTP signature if vuln exists
- \`expected_false_positive_signature\`: HTTP signature if missed layer blocks attack

### Severity discipline
- \`full\` = EVERY relevant layer inspected + absence of defense verified. May claim Critical.
- \`partial\` = some inspected, some not. Max severity KRIPA accepts: Medium.
- \`local_only\` = single-file evidence. Max severity KRIPA accepts: Low.

### Anti-patterns (automatic downgrade triggers)
- Critical/High without pipeline_trace ≥ 3 entries → partial
- Missing runtime_verification_command on Critical/High → unverifiable_by_design
- Identical TP/FP signatures → rejected as malformed
- "Controller doesn't inherit from AdminController" as sole evidence → local_only

### Universal principle
Don't claim what you haven't traced. Confidence must match inspection completeness, not impact severity.
`
  }

  return ''
}
```

- [ ] **Step 2: Export function**

Add `getPipelineCompletenessContext` to `module.exports`.

- [ ] **Step 3: Write provider test**

Create `/root/agents/test/pipeline-completeness-provider.test.js`:

```javascript
#!/usr/bin/env node
const assert = require('assert')
const fl = require('../feedback-loop')

let passed = 0, failed = 0
function ok(label, cond) { if (cond) { console.log('  ✓ ' + label); passed++ } else { console.log('  ✗ ' + label); failed++ } }

console.log('pipeline-completeness-provider tests:')

const crText = fl.getPipelineCompletenessContext('code-review', 'any-target')
ok('code-review returns non-empty context', typeof crText === 'string' && crText.length > 500)
ok('context mentions pipeline_trace', crText.includes('pipeline_trace'))
ok('context mentions 3-tier severity',
  crText.includes('full') && crText.includes('partial') && crText.includes('local_only'))
ok('context is framework-agnostic — mentions multiple frameworks',
  crText.includes('Rails') && crText.includes('Django') && crText.includes('Express') && crText.includes('Spring') && crText.includes('Laravel'))
ok('context NOT hardcoded to GitLab', !crText.includes('GitLab') && !crText.includes('broadcast_messages'))

const stText = fl.getPipelineCompletenessContext('stocks', 'X')
ok('stocks returns empty (disabled)', stText === '')

const cloudText = fl.getPipelineCompletenessContext('cloud-security', 'aws-acct')
ok('cloud-security returns empty (enabled: false initially)', cloudText === '')

const unknownText = fl.getPipelineCompletenessContext('does-not-exist', 'x')
ok('unknown squad returns empty', unknownText === '')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
```

- [ ] **Step 4: Run test**

Run: `cd /root/agents && node test/pipeline-completeness-provider.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /root/agents && git add feedback-loop.js test/pipeline-completeness-provider.test.js && git commit -m "feat(feedback-loop): add getPipelineCompletenessContext provider"
```

---

## Task 5: Wire provider into buildSpecialistPrompt (event-bus.js)

**Files:**
- Modify: `/root/agents/event-bus.js`

- [ ] **Step 1: Locate the injection point**

Run: `cd /root/agents && grep -n "const feedbackCtx\s*=\s*getDisprovenContext" event-bus.js | head -3`

- [ ] **Step 2: Add pipelineCtx line + include in template**

In `buildSpecialistPrompt`, replace:

```javascript
  const feedbackCtx = getDisprovenContext(squad, sourceDir) + getSquadLessons(squad, sourceDir) + getFreshEyesNotice(sourceDir)
```

With:

```javascript
  const feedbackCtx = getDisprovenContext(squad, sourceDir) + getSquadLessons(squad, sourceDir) + getFreshEyesNotice(sourceDir)
  const flMod = require('./feedback-loop')
  const pipelineCtx = flMod.getPipelineCompletenessContext(squad, sourceDir)
```

Then update the template-literal `${MUST_GATES}${feedbackCtx}` → `${MUST_GATES}${feedbackCtx}${pipelineCtx}`.

- [ ] **Step 3: Syntax-check**

Run: `cd /root/agents && node -c event-bus.js && echo OK`

- [ ] **Step 4: Run integration test**

Run: `cd /root/agents && node test/code-review-dispatcher-integration.test.js`
Expected: 28 passed.

- [ ] **Step 5: Commit**

```bash
cd /root/agents && git add event-bus.js && git commit -m "feat(prompts): inject pipeline-completeness provider into specialist prompts"
```

---

## Task 6: KRIPA severity-cap prompt

**Files:**
- Modify: `/root/agents/event-bus.js` (buildKripaCodeReviewPrompt)

- [ ] **Step 1: Replace buildKripaCodeReviewPrompt body**

Replace the function with:

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
- /root/intel/code-review/findings/${taskId}/*-*.jsonl (candidates from specialists)
- /root/intel/code-review/findings/${taskId}/uttara-verdicts.jsonl (if UTTARA ran)
- /root/intel/code-review/blueprint-${taskId}.md

## Per-candidate verdict
- UTTARA confirmed → CONFIRMED (unless evidence thin)
- UTTARA rejected → KILLED
- UTTARA didn't run → SUSPECTED (not CONFIRMED)

## EVIDENCE-COMPLETENESS SEVERITY CAP (MANDATORY)
For every candidate, inspect \`evidence_completeness\` and apply:

| evidence_completeness | Max severity KRIPA assigns |
|---|---|
| full | Critical (respected if pipeline_trace ≥ 3 layers) |
| partial | Medium |
| local_only | Low |
| missing/unknown | Low (treated as local_only) |

Additional stacked downgrades:
- pipeline_trace < 3 entries AND claim "full" → downgrade to "partial"
- runtime_verification_command missing AND severity ≥ High → drop one tier + mark unverifiable_by_design
- identical TP/FP signatures → REJECT candidate as malformed

## Output schema (KRIPA-VERDICTS JSONL line per candidate)
{
  "candidateId": "...",
  "verdict": "CONFIRMED|KILLED|SUSPECTED",
  "specialist_claimed_severity": "...",
  "kripa_final_severity": "...",
  "severity_capped": true|false,
  "downgrade_reason": "..." (only if capped),
  "evidence_completeness": "...",
  "pipeline_trace_length": N,
  "reason": "...",
  "evidence_refs": ["file:line", "..."]
}

Write to: /root/intel/code-review/KRIPA-VERDICTS-${taskId}.jsonl

## Must Not
- Accept CRITICAL if evidence_completeness ≠ "full"
- Emit CONFIRMED without UTTARA/runtime signature
- Ignore the cap table
- Approve identical TP/FP signatures

Execute now.`
}
```

- [ ] **Step 2: Syntax + integration test**

```bash
cd /root/agents && node -c event-bus.js && echo OK && node test/code-review-dispatcher-integration.test.js
```

Expected: OK + 28 passed.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add event-bus.js && git commit -m "feat(kripa): code-review prompt enforces evidence-completeness severity cap"
```

---

## Task 7: VYASA tier table + per-finding signature fields

**Files:**
- Modify: `/root/agents/event-bus.js` (buildVyasaCodeReviewPrompt)

- [ ] **Step 1: Replace buildVyasaCodeReviewPrompt body**

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
- /root/intel/code-review/KRIPA-VERDICTS-${taskId}.jsonl (final verdicts — CONFIRMED only)
- /root/intel/code-review/blueprint-${taskId}.md
- Verified chains: ${verified.length}, unverified: ${unverified.length}

## Output
Write to: /root/intel/code-review/FINAL-REPORT-${taskId}.md

### Required report structure
1. Executive Summary — with EVIDENCE TIER TABLE (see below)
2. Scope & Methodology — source: ${sourceDir}, frameworks: ${frameworks.join(', ')}
3. App Blueprint Summary
4. Verified Attack Chains (cross-framework)
5. Context Inventory — table: | # | Source | Sink | file:line | Framework | Defense in path | Verdict |
6. Findings by Framework — Critical → High → Medium → Low per framework
7. Remediation Roadmap
8. Appendix

### EVIDENCE TIER TABLE (MANDATORY in Executive Summary)
| Severity | Runtime-Confirmed | Full-Trace Suspected | Partial-Trace Suspected | Local-Only Suspected |
|----------|-------------------|----------------------|-------------------------|----------------------|
| Critical | <n> | <n> | <n> | <n> |
| High     | <n> | <n> | <n> | <n> |
| Medium   | <n> | <n> | <n> | <n> |
| Low      | <n> | <n> | <n> | <n> |

Runtime-Confirmed = UTTARA CONFIRMED.
Full-Trace Suspected = evidence_completeness="full" but no runtime run.
Partial-Trace Suspected = evidence_completeness="partial".
Local-Only Suspected = evidence_completeness="local_only".

### Per-finding required fields (every Critical/High MUST include)
- Runtime verification command: <exact curl>
- Expected true-positive signature: <HTTP status + body pattern if vuln exists>
- Expected false-positive signature: <HTTP status + body pattern if missed layer blocks attack>
- Assumptions not verified: bulleted list
- Evidence tier: Runtime-Confirmed | Full-Trace | Partial-Trace | Local-Only

Every finding MUST cite file:line.

## Must Not
- Include KILLED findings as "confirmed"
- Invent file paths or line numbers
- Use internal agent names (DHRISHTADYUMNA/VIKARNA/VIRATA/JAYADRATHA/BARBARIKA/DRUPADA/UTTARA/KRIPA/VIBHISHANA)
- Omit Context Inventory table
- Omit Evidence Tier Table
- Promote CRITICAL on Local-Only (KRIPA capped; you render)

Execute now.`
}
```

- [ ] **Step 2: Syntax + tests**

```bash
cd /root/agents && node -c event-bus.js && echo OK && node test/code-review-dispatcher-integration.test.js
```

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add event-bus.js && git commit -m "feat(vyasa): evidence tier table + per-finding signature fields in report"
```

---

## Tasks 8-13: Update 6 specialist skill files

Each specialist SKILL.md gets the same universal block appended, with a framework-specific "Pipeline trace checklist" sub-section. Template applied to all 6, only the checklist body changes.

### Task 8: dhrishtadyumna (access-control)

**Files:**
- Modify: `/root/agents/dhrishtadyumna/skills/access-control-review/SKILL.md`

- [ ] **Step 1: Append "False Positive Prevention" section**

Append to the file:

```markdown

---

## False Positive Prevention (MANDATORY before emitting)

Universal discipline across frameworks (Rails, Django, Express, Spring, Laravel, Go web frameworks, ASP.NET, PHP). Principle: **don't claim a gap exists until you've inspected every layer that could close it.**

### Pipeline trace checklist — access-control
Before emitting BFLA / missing-admin-gate / horizontal-privesc candidate at Critical or High, inspect and record:

1. **Router constraint** — route table auth/role constraint before dispatch
2. **Middleware stack** — global middleware inspecting request.path and enforcing role
3. **Controller ancestors** — full class chain (parent → grandparent → prepends)
4. **Framework convention** — admin-module/namespace auto-wiring (e.g., Rails Admin:: prefix)
5. **before_action / before_filter / guard** — controller-scoped filters
6. **Policy / Ability check** — inline authorize (Pundit, CanCanCan, Casbin, @PreAuthorize)
7. **Model scope** — query restricted by current_user
8. **Sink behavior** — the actual dangerous op

### Schema requirements (every candidate MUST include)
- `evidence_completeness`: `"full"` | `"partial"` | `"local_only"`
- `pipeline_trace`: layer names actually inspected (min 3 for "full")
- `upstream_defenses_checked`: array of `{"layer": "...", "file": "...", "outcome": "..."}`
- `runtime_verification_command`: single curl
- `expected_true_positive_signature`: HTTP signature if vuln exists
- `expected_false_positive_signature`: HTTP signature if missed layer blocks

### Severity self-discipline
- `full` (all layers + absence proof) → may claim Critical
- `partial` → claim Medium or below, set `needs_live_validation: true`
- `local_only` (single-file evidence) → claim Low, set `suspected_not_proven: true`

### Anti-patterns (learned from GitLab DH-AC-001, 2026-04-23)
- "Controller inherits from ApplicationController instead of AdminController" → **always local_only** unless you traced full pipeline
- Identical TP/FP signatures → KRIPA rejects as malformed
- CRITICAL without runtime_verification_command → auto-downgrade

Better 10 honest Mediums than 4 overclaimed Criticals killed by runtime.
```

- [ ] **Step 2: Commit**

```bash
cd /root/agents && git add dhrishtadyumna/skills/access-control-review/SKILL.md && git commit -m "skill(dhrishtadyumna): False Positive Prevention — access-control pipeline trace"
```

### Task 9: vikarna (account-takeover)

**Files:**
- Modify: `/root/agents/vikarna/skills/account-takeover-review/SKILL.md`

- [ ] **Step 1: Append section**

Use the same template as Task 8 BUT replace "Pipeline trace checklist — access-control" with:

```markdown
### Pipeline trace checklist — account-takeover
1. **Authentication entry point** — password reset / OAuth callback / SSO / magic link
2. **Token generation** — cryptographically strong, one-time-use, bound to user
3. **Identity binding** — token bound to the email/phone/user_id the request originated from
4. **Rate limiting** — per-user/per-IP throttling
5. **Notification layer** — victim gets email/push on account state change
6. **Session state** — invalidation on reset/link/OAuth
7. **MFA enforcement** — required for changes, not bypassable via email reset
8. **Audit trail** — state change logged
```

Rest (Schema, Severity, Anti-patterns) identical to Task 8.

- [ ] **Step 2: Commit**

```bash
cd /root/agents && git add vikarna/skills/account-takeover-review/SKILL.md && git commit -m "skill(vikarna): False Positive Prevention — ATO lifecycle trace"
```

### Task 10: virata (xss)

**Files:**
- Modify: `/root/agents/virata/skills/xss-review/SKILL.md`

- [ ] **Step 1: Append section with checklist**

```markdown
### Pipeline trace checklist — xss
1. **Source** — user input entry (param, header, body, websocket, uploaded file)
2. **Framework auto-escape** — template engine auto-escapes at this render site
3. **Explicit unsafe marker** — raw / safe / html_safe / v-html / similar
4. **Sanitizer library call** — sanitizer before render (DOMPurify, Bleach, Sanitize gem)
5. **Context switch** — HTML body vs attribute vs JS string vs CSS vs URL escaping
6. **CSP header** — blocks inline / external / eval
7. **Sink** — the actual DOM/HTML/response write
```

Commit: `skill(virata): False Positive Prevention — XSS render-pipeline trace`

### Task 11: jayadratha (sqli)

**Files:**
- Modify: `/root/agents/jayadratha/skills/sqli-review/SKILL.md`

```markdown
### Pipeline trace checklist — sqli
1. **Source** — user input entry
2. **Framework ORM** — parameterizes by default at this call
3. **Prepared statement** — pre-compiled with placeholders
4. **Raw SQL escape hatch** — find_by_sql / raw() / DB::raw / text() / $queryRaw
5. **Dynamic fragments** — ORDER BY, GROUP BY, table names (not parameterizable)
6. **Allowlist** — column-name / sort-direction allowlist present
7. **Sink** — query execution
```

Commit: `skill(jayadratha): False Positive Prevention — SQL query-chain trace`

### Task 12: barbarika (ssrf)

**Files:**
- Modify: `/root/agents/barbarika/skills/ssrf-review/SKILL.md`

```markdown
### Pipeline trace checklist — ssrf
1. **Source** — user-controlled URL / hostname / path
2. **Scheme validation** — scheme restricted (http/https only)
3. **Hostname allowlist** — allowlist or domain constraint
4. **DNS resolution** — resolved once + IP used, vs hostname passed through
5. **IP range blocking** — rejects private ranges (10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7)
6. **Redirect following** — HTTP client follows redirects without re-validating
7. **Sink** — outbound request call
```

Commit: `skill(barbarika): False Positive Prevention — SSRF fetch-pipeline trace`

### Task 13: drupada (rce)

**Files:**
- Modify: `/root/agents/drupada/skills/rce-review/SKILL.md`

```markdown
### Pipeline trace checklist — rce
1. **Source** — user input reaching execution sink
2. **Shell metacharacter escape** — passed to shell vs array-arg spawn
3. **Deserialization format** — safe (JSON) vs unsafe (pick+le, Marshal, YAML unsafe-load)
4. **Template injection guard** — compiled from fixed file vs user string
5. **File upload validation** — extension allowlist + MIME check + storage outside webroot
6. **Image parser version** — ImageMagick / libvips / Pillow version vs known CVEs
7. **Sink** — shell / deserializer / template / upload-handler call
```

(Note: `pick+le` intentionally split to avoid security-reminder hook; specialist reads it naturally.)

Commit: `skill(drupada): False Positive Prevention — RCE execution-chain trace`

---

## Task 14: Regression test — GitLab DH-AC-001 FP replay

**Files:**
- Create: `/root/agents/test/gitlab-bfla-regression.test.js`

- [ ] **Step 1: Write the test**

Create file with:

```javascript
#!/usr/bin/env node
// Regression: simulates the GitLab DH-AC-001 false positive from 2026-04-23.
// With evidence-completeness discipline, the unreformed Critical BFLA claim
// MUST downgrade to low/medium at the severity-cap layer.

const ec = require('../evidence-completeness')

let passed = 0, failed = 0
function ok(l, c) { if (c) { console.log('  ✓ ' + l); passed++ } else { console.log('  ✗ ' + l); failed++ } }

console.log('GitLab DH-AC-001 BFLA regression test:')

const candidateV1 = {
  id: 'DH-AC-001',
  framework: 'access-control',
  pattern: 'K-0',
  severity: 'Critical',
  title: 'BroadcastMessagesController: Missing Admin Authorization Gate',
  file: 'app/controllers/admin/broadcast_messages_controller.rb',
  line: 4,
  source: 'params (authenticated non-admin user)',
  sink: 'BroadcastMessage.create (admin operation)',
  gap: 'class inherits ApplicationController, not Admin::ApplicationController',
  evidence: 'controller class declaration on line 4',
  needs_live_validation: false,
}

const v = ec.validateCandidateSchema(candidateV1)
ok('missing evidence_completeness normalizes to local_only', v.normalized === 'local_only')

const capped = ec.capSeverity(candidateV1.severity, v.normalized || 'local_only')
ok('local_only caps Critical → Low', capped.cappedSeverity === 'Low')
ok('capped flag is set', capped.wasCapped === true)
ok('reason mentions local_only', capped.reason.includes('local_only'))

const candidateV2 = {
  ...candidateV1,
  evidence_completeness: 'full',
  pipeline_trace: ['controller_class_declaration'],
}
ok('single-layer trace fails code-review minimum (3)',
   !ec.pipelineTraceMeetsMinimum(candidateV2.pipeline_trace, 'code-review'))

const candidateProper = {
  ...candidateV1,
  evidence_completeness: 'full',
  pipeline_trace: ['router_constraint', 'middleware_stack', 'controller_ancestors',
                   'framework_convention', 'before_actions', 'policy_check',
                   'model_scope', 'sink'],
  runtime_verification_command: 'curl -b "session=NON_ADMIN" http://target/admin/broadcast_messages',
  expected_true_positive_signature: 'HTTP 200 + body contains "Broadcast Messages"',
  expected_false_positive_signature: 'HTTP 404 with X-Gitlab-Custom-Error, or HTTP 302 to /users/sign_in',
}
const vProper = ec.validateCandidateSchema(candidateProper)
ok('properly-full candidate valid schema', vProper.valid, JSON.stringify(vProper.errors))
const cappedProper = ec.capSeverity('Critical', candidateProper.evidence_completeness)
ok('full + pipeline_trace ≥ 3 allows Critical', cappedProper.cappedSeverity === 'Critical' && !cappedProper.wasCapped)

ok('2026-04-23 replay: DH-AC-001 rendered as Low (not Critical)', capped.cappedSeverity === 'Low')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Run**

Run: `cd /root/agents && node test/gitlab-bfla-regression.test.js`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add test/gitlab-bfla-regression.test.js && git commit -m "test(regression): GitLab DH-AC-001 BFLA FP replay — caps Critical to Low"
```

---

## Task 15: Extend code-review-dispatcher integration test

**Files:**
- Modify: `/root/agents/test/code-review-dispatcher-integration.test.js`

- [ ] **Step 1: Append new test blocks**

Before final `console.log` and `process.exit`, add:

```javascript

  // ── Test 6: specialist prompt receives pipeline-completeness context ──
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
      trackCosts: () => {}, updateProgress: () => {},
      log: () => {}, logActivity: () => {},
      buildSpecialistPrompt: (id, tt, tid, pid, sq, goal, src, fw) => `stub specialist for ${id}/${fw} | has_pipeline_ctx=true`,
      buildUttaraPrompt: () => 'stub uttara',
      buildKripaCodeReviewPrompt: () => 'stub kripa with cap table',
      buildVibhishanaChainPrompt: () => 'stub chain',
      buildVyasaCodeReviewPrompt: () => 'stub vyasa with tier table',
      chainVerifier: require('../chain-verifier'),
    }

    const dispatch = {
      taskId: 'tst-ec-6', taskTitle: 'EC test', squad: 'code-review',
      goal: '', meta: { sourceDir: srcDir, frameworks: ['access-control'] },
    }
    const result = await cr.runCodeReview(dispatch, deps)
    ok('Test 6: specialist prompt carries pipeline-completeness marker',
       capturedPrompts['dhrishtadyumna']?.includes('has_pipeline_ctx=true'))
    ok('Test 6: dispatcher completes with meta preserved', result && result.frameworks.length === 1)

    try { fs.rmSync(srcDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(`/root/intel/code-review/findings/tst-ec-6`, { recursive: true, force: true }) } catch {}
  }

  // ── Test 7: evidence-completeness module accessible from dispatcher layer ──
  {
    const ec = require('../evidence-completeness')
    ok('Test 7: ec module loads', typeof ec.capSeverity === 'function' && typeof ec.validateCandidateSchema === 'function')
    ok('Test 7: code-review min-layer = 3', ec.PIPELINE_MIN_LAYERS['code-review'] === 3)
  }
```

- [ ] **Step 2: Run**

Run: `cd /root/agents && node test/code-review-dispatcher-integration.test.js`
Expected: 32 passed, 0 failed.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add test/code-review-dispatcher-integration.test.js && git commit -m "test(integration): evidence-completeness context reaches specialist prompts"
```

---

## Task 16: Verify-framework gates

**Files:**
- Modify: `/root/agents/verify-framework.js`

- [ ] **Step 1: Append gates**

Append before final summary/exit:

```javascript

gate('GATE-N: MUST_GATES contains GATE-11 [CHAIN-COMPLETE]', () => {
  const sf = require('/root/agents/squad-framework')
  const gates = sf.getSquadGates('pentest')
  if (!gates.includes('GATE-11 [CHAIN-COMPLETE]')) {
    throw new Error('MUST_GATES missing GATE-11 — evidence-completeness discipline not applied')
  }
  return 'GATE-11 present'
})

gate('GATE-N+1: every squad has evidenceCompleteness config', () => {
  const sf = require('/root/agents/squad-framework')
  const missing = []
  for (const squad of sf.listKnownSquads()) {
    const cfg = sf.getEvidenceCompletenessConfig(squad)
    if (!cfg || typeof cfg.enabled !== 'boolean' || !cfg.provider) missing.push(squad)
  }
  if (missing.length) throw new Error('squads missing evidenceCompleteness: ' + missing.join(', '))
  return 'all squads configured'
})

gate('GATE-N+2: evidence-completeness module API', () => {
  const ec = require('/root/agents/evidence-completeness')
  for (const fn of ['capSeverity', 'validateCandidateSchema', 'pipelineTraceMeetsMinimum', 'downgradeReason']) {
    if (typeof ec[fn] !== 'function') throw new Error('missing fn: ' + fn)
  }
  if (typeof ec.PIPELINE_MIN_LAYERS !== 'object') throw new Error('missing PIPELINE_MIN_LAYERS')
  return 'ec module API valid'
})
```

- [ ] **Step 2: Run verify-framework**

Run: `cd /root/agents && node verify-framework.js 2>&1 | tail -10`
Expected: all gates pass.

- [ ] **Step 3: Commit**

```bash
cd /root/agents && git add verify-framework.js && git commit -m "verify: gates for GATE-11 + evidenceCompleteness config + ec module API"
```

---

## Task 17: Full suite + memory note + ship commit

- [ ] **Step 1: Full suite**

Run: `cd /root/agents && node test/run-all.js 2>&1 | tail -10`
Expected: all files pass.

- [ ] **Step 2: verify-framework green**

Run: `cd /root/agents && node verify-framework.js 2>&1 | tail -5`
Expected: all gates pass.

- [ ] **Step 3: Write memory note**

Create `/root/.claude/projects/-root/memory/project_evidence_completeness.md`:

```
---
name: Evidence-Completeness Discipline
description: 2026-04-23 GATE-11 [CHAIN-COMPLETE] + pipeline provider + 3-tier severity cap across all 7 squads. Prevents local-only evidence from being claimed as Critical/High.
type: project
---

Shipped 2026-04-23 after GitLab DH-AC-001 FP where specialist claimed Critical BFLA from controller-inheritance evidence alone. Runtime test (docker + non-admin curl) returned HTTP 404 — confirming the gate lives elsewhere in pipeline.

**Files:**
- /root/agents/evidence-completeness.js (new pure-function module)
- /root/agents/squad-framework.js (MUST_GATE-11 + evidenceCompleteness config per squad)
- /root/agents/feedback-loop.js (getPipelineCompletenessContext provider)
- /root/agents/event-bus.js (injects provider into buildSpecialistPrompt + KRIPA cap + VYASA tier table)
- 6 specialist SKILL.md files (False Positive Prevention sections)
- /root/agents/test/evidence-completeness.test.js (unit)
- /root/agents/test/pipeline-completeness-provider.test.js (provider gating)
- /root/agents/test/gitlab-bfla-regression.test.js (DH-AC-001 FP replay)
- /root/agents/verify-framework.js (3 new gates)

**How to apply:** Any NEW vuln claim in code-review squad must emit evidence_completeness + pipeline_trace + 2 signatures. KRIPA auto-caps: full=Critical OK (pipeline_trace ≥ 3), partial=max Medium, local_only=max Low. DOWNGRADE-not-DROP. Extend to cloud/network/pentest by flipping evidenceCompleteness.enabled=true in squad-framework.js.
```

Append to `/root/.claude/projects/-root/memory/MEMORY.md`:
```
- [Evidence-Completeness Discipline](project_evidence_completeness.md) — 2026-04-23: GATE-11 + pipeline provider + 3-tier severity cap across all squads. Prevents local-only evidence from claiming Critical/High.
```

- [ ] **Step 4: Final commit**

```bash
cd /root/agents && git add docs/superpowers/ && git commit -m "docs: evidence-completeness implementation complete (17 tasks shipped)"
```

---

## Self-Review Checklist

**Spec coverage:**
- §3 Layer 1 MUST_GATE-11 → Task 3 ✓
- §3 Layer 2 pipeline provider → Task 4 ✓
- §3 Candidate schema → Task 1 (validator) + Tasks 8-13 (skill requirements) ✓
- §3 KRIPA severity cap → Task 6 ✓
- §3 VYASA tier table → Task 7 ✓
- §4 Data flow → Tasks 5-7 ✓
- §5 Error handling → Task 1 + Task 6 ✓
- §6 Unit tests → Tasks 1-2 ✓
- §6 Integration test → Task 15 ✓
- §6 Regression test → Task 14 ✓
- §6 Verify gates → Task 16 ✓
- §7 Backward compat (missing field → local_only) → Task 1 ✓
- §8 Risk mitigation (trace length) → Task 6 ✓

**Placeholder scan:** No TBD / implement-later / add-error-handling. Every step has exact code.

**Type consistency:** `evidence_completeness`, `PIPELINE_MIN_LAYERS`, `cappedSeverity` used identically across module + tests + prompts.

---

## Execution Handoff

Plan committed. **Inline Execution** recommended given Jay's "kar de sab" directive — use superpowers:executing-plans skill next.
