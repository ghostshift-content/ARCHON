// test/evidence-contract.test.js
//
// "No captured evidence → not CONFIRMED." hasEvidence truth table + the demotion
// (CONFIRMED without replayable evidence → NEEDS-LIVE, with a reason).

const assert = require('node:assert')
const { test } = require('node:test')
const { hasEvidence, enforceContract } = require('../src/pipeline/evidence-contract')

test('hasEvidence: reproduction method/result/string counts', () => {
  assert.strictEqual(hasEvidence({ reproduction_method: "curl 'https://x/y'" }), true)
  assert.strictEqual(hasEvidence({ reproduction_result: '200 OK, header absent' }), true)
  assert.strictEqual(hasEvidence({ reproduction: 'POST /login ... 302' }), true)
})

test('hasEvidence: non-trivial proof blob counts; tiny one does not', () => {
  assert.strictEqual(hasEvidence({ proof: 'HTTP/1.1 500 with full stack trace leaking path' }), true)
  assert.strictEqual(hasEvidence({ proof: 'short' }), false)
})

test('hasEvidence: nonce-confirmed proof_of_execution counts; unconfirmed does not', () => {
  assert.strictEqual(hasEvidence({ proof_of_execution: { confirmed: true } }), true)
  assert.strictEqual(hasEvidence({ proof_of_execution: { confirmed: false } }), false)
})

test('hasEvidence: nothing → false', () => {
  assert.strictEqual(hasEvidence({}), false)
  assert.strictEqual(hasEvidence(null), false)
  assert.strictEqual(hasEvidence({ title: 'SQLi', severity: 'High' }), false) // claim, no evidence
})

test('enforceContract: CONFIRMED with no evidence → demoted to NEEDS-LIVE', () => {
  const out = enforceContract({ id: 'F1', validation_status: 'CONFIRMED', title: 'SQLi' })
  assert.strictEqual(out.validation_status, 'NEEDS-LIVE')
  assert.strictEqual(out.evidence_demoted, true)
  assert.match(out.evidence_demoted_reason, /without replayable evidence/)
})

test('enforceContract: CONFIRMED WITH evidence → unchanged', () => {
  const rec = { id: 'F2', validation_status: 'CONFIRMED', reproduction_method: "curl 'https://x'" }
  const out = enforceContract(rec)
  assert.strictEqual(out.validation_status, 'CONFIRMED')
  assert.ok(!out.evidence_demoted)
})

test('enforceContract: non-CONFIRMED statuses pass through untouched', () => {
  assert.strictEqual(enforceContract({ validation_status: 'NEEDS-LIVE' }).validation_status, 'NEEDS-LIVE')
  assert.strictEqual(enforceContract({ validation_status: 'KILLED' }).validation_status, 'KILLED')
})
