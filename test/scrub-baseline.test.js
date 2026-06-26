#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Unit tests for scrubBaselineFromGoal — prevents sycophantic baseline-number
// mirroring in specialist/KRIPA/VYASA outputs (Apr-21 Run 1 regression guard).
// Run: node /root/agents/test/scrub-baseline.test.js
// Exit 0 = all pass. Non-zero = regression.

const assert = require('assert')
const { scrubBaselineFromGoal: scrub } = require('../src/safety/scrub-baseline')

let passed = 0
let failed = 0

function test(label, goal, mustNotContain, mustContain = []) {
  const out = scrub(goal)
  let bad = null
  for (const s of mustNotContain) if (out.includes(s)) bad = `leaked substring: ${JSON.stringify(s)}`
  if (!bad) for (const s of mustContain) if (!out.includes(s)) bad = `missing substring: ${JSON.stringify(s)}`
  if (bad) {
    console.log(`  ✗ ${label}`)
    console.log(`    ${bad}`)
    console.log(`    got: ${JSON.stringify(out)}`)
    failed++
  } else {
    console.log(`  ✓ ${label}`)
    passed++
  }
}

console.log('scrubBaselineFromGoal tests:')

// The exact pathological goal text that caused the Run-1 bug
test(
  'strips Apr-20 baseline with finding counts and chain counts',
  `Re-run full pentest on hrconnect.emiratesnbd.com using the updated framework. Apr-20 baseline FINAL-REPORT at ${__roots.INTEL_ROOT}/pentest/FINAL-REPORT.md = 19 confirmed findings (2 CRIT + 7 HIGH + 5 MED + 5 LOW) with 11 critical/high attack chains. Goal: match or exceed this baseline on severity coverage.`,
  ['19 confirmed findings', 'Apr-20 baseline', 'match or exceed', '11 critical/high attack chains', '2 CRIT + 7 HIGH']
)

test(
  'preserves ordinary numbers unrelated to baseline',
  `Test 5 parameters per endpoint. Use 3 different encodings. Log every 10 findings.`,
  ['baseline'],
  ['5 parameters', '3 different encodings']
)

test(
  'strips "compared to last run" comparison language',
  `Check auth coverage compared to last Apr-20 run and report deltas.`,
  ['compared to', 'Apr-20']
)

test(
  'strips "exceed this baseline" imperatives',
  `Do thorough recon and exceed this baseline on chain count.`,
  ['exceed this baseline']
)

test(
  'strips "= N findings" anchor patterns',
  `Target hrconnect. Prior scan = 19 findings which you should reproduce.`,
  ['= 19 findings']
)

// Null/undefined safety
assert.strictEqual(scrub(null), '', 'null → empty')
assert.strictEqual(scrub(undefined), '', 'undefined → empty')
assert.strictEqual(scrub(''), '', 'empty → empty')
console.log(`  ✓ null/undefined/empty safe`)
passed++

test(
  'leaves normal pentest instruction goal alone',
  `Pentest hrconnect.emiratesnbd.com. Scope: blackbox. Authorization: confirmed. ROE: no out-of-scope assets.`,
  ['baseline', 'match or exceed'],
  ['Pentest hrconnect.emiratesnbd.com', 'Scope: blackbox', 'Authorization', 'ROE']
)

test(
  'preserves anti-bias language (not a baseline anchor)',
  `Run full pentest. Apply anti-bias: verdicts must be driven by evidence not dispatcher sycophancy.`,
  [],
  ['anti-bias', 'dispatcher sycophancy']
)

// The complete Apr-21 dispatch goal text verbatim — regression guard
test(
  'full Apr-21 dispatch goal text — no baseline leakage',
  `Re-run full pentest on hrconnect.emiratesnbd.com using the updated framework (squad-aware modelRouter, anti-bias discipline, sonnet stock_analyst uplift applied where relevant, modelRouter fixes from 2026-04-20, DHARMARAJ on modelRouter not hardcoded sonnet, LLM grader on modelRouter.resolveFamily('fast')). Apr-20 baseline FINAL-REPORT at ${__roots.INTEL_ROOT}/pentest/FINAL-REPORT.md = 19 confirmed findings (2 CRIT + 7 HIGH + 5 MED + 5 LOW) with 11 critical/high attack chains. Goal: match or exceed this baseline on severity coverage AND show measurable quality improvements`,
  ['Apr-20 baseline', '2 CRIT', '7 HIGH', '5 MED', '5 LOW', 'match or exceed', '11 critical/high attack chains', '= 19 confirmed findings'],
  ['Re-run full pentest on hrconnect.emiratesnbd.com', 'anti-bias discipline', 'squad-aware modelRouter']
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
