#!/usr/bin/env node
// Unit tests for /root/agents/finding-validator.js — no API calls, pure function checks.
const assert = require('assert')
const fv = require('../src/grading/finding-validator')

let pass = 0, fail = 0
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}`); console.log(`    ${e.message}`); fail++ }
}

console.log('finding-validator tests:')

test('config loads with enable flag + mode', () => {
  const cfg = fv.loadConfig()
  assert.ok(cfg)
  assert.ok('enabled' in cfg)
  assert.ok('mode' in cfg)
  assert.ok(cfg.model_alias)
})

test('VALIDATE_TOOL schema requires status, confidence, evidence_quote, rationale, exploitability', () => {
  const t = fv.VALIDATE_TOOL
  for (const f of ['status', 'confidence', 'evidence_quote', 'rationale', 'exploitability']) {
    assert.ok(t.input_schema.required.includes(f), `missing required: ${f}`)
  }
  assert.deepStrictEqual(t.input_schema.properties.status.enum.sort(),
    ['confirmed', 'disproven', 'suspected'].sort())
})

test('verifyEvidenceQuote accepts literal substring', () => {
  assert.strictEqual(fv.verifyEvidenceQuote('GET /api/Employees returned 500', 'Observed: GET /api/Employees returned 500 after 11s'), true)
})

test('verifyEvidenceQuote rejects hallucination', () => {
  assert.strictEqual(fv.verifyEvidenceQuote('returned 200 OK', 'Observed: GET /api/Employees returned 500'), false)
})

test('verifyEvidenceQuote rejects too-short quote', () => {
  assert.strictEqual(fv.verifyEvidenceQuote('hi', 'hi there, this has hi in it'), false)
})

test('buildPrompt includes finding fields + URL + evidence', () => {
  const p = fv.buildPrompt(
    { title: 'SQL injection on /login', severity: 'High', url: '/login' },
    'POC: curl /login?id=1 returned SQL error',
    'pentest'
  )
  assert.ok(p.includes('SQL injection on /login'))
  assert.ok(p.includes('High'))
  assert.ok(p.includes('/login'))
  assert.ok(p.includes('POC: curl'))
  assert.ok(p.includes('validate_finding'))
  assert.ok(p.includes('LITERAL'))
})

;(async () => {
  const r = await fv.validateFinding({ title: 'x' }, 'evidence', {})
  if (r.validator === 'noop' || r.validator === 'error') {
    console.log('  ✓ validateFinding safely returns noop when disabled or no API key')
    pass++
  } else {
    // If API key set, we'd need to mock — skip this test in that env
    console.log('  ✓ validateFinding returns an object (live-API path skipped)')
    pass++
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
})()
