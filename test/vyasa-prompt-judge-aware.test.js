// test/vyasa-prompt-judge-aware.test.js
//
// Module-level grep tests confirming VYASA's pentest report prompt references
// the JUDGED-FINDINGS file produced by Phase 3.9 (G1 Judge Verifier) and
// teaches the report writer how to interpret judge_verdict.
//
// Spec: docs/superpowers/specs/2026-05-07-G1-phase-2-event-bus-wiring.md §3.3

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')

test('VYASA prompt mentions JUDGED-FINDINGS file', () => {
  assert.match(SRC, /JUDGED-FINDINGS-\$\{taskId\}\.jsonl|JUDGED-FINDINGS-/,
    'must reference the JUDGED-FINDINGS file format')
})

test('VYASA prompt explains judge_verdict=confirmed means severity preserved', () => {
  assert.match(SRC, /judge_verdict[\s\S]{0,200}confirmed[\s\S]{0,400}(preserve|original|kept|retain)/i,
    'must teach that confirmed = severity preserved')
})

test('VYASA prompt explains judge_verdict=downgraded means use the new severity', () => {
  assert.match(SRC, /judge_verdict[\s\S]{0,400}downgraded[\s\S]{0,500}(new severity|reduced|use|reflect)/i,
    'must teach that downgraded = use new severity (not original)')
})

test('VYASA prompt explains not-judged means below threshold', () => {
  assert.match(SRC, /not-judged[\s\S]{0,300}(below|threshold|Medium|Low|Info)/i,
    'must explain not-judged is below severity filter threshold')
})

test('VYASA prompt explains indeterminate means flag for manual review', () => {
  assert.match(SRC, /indeterminate[\s\S]{0,300}(manual|flag|review|unavailable)/i,
    'must teach that indeterminate findings need manual review flag')
})

test('VYASA prompt judge integration is INSIDE buildVyasaReportPrompt body', () => {
  const fnStart = SRC.indexOf('function buildVyasaReportPrompt')
  assert.ok(fnStart > 0, 'buildVyasaReportPrompt missing')
  const fnSlice = SRC.slice(fnStart, fnStart + 12000)
  assert.match(fnSlice, /JUDGED-FINDINGS|judge_verdict/,
    'JUDGED-FINDINGS reference must be inside the function body')
})
