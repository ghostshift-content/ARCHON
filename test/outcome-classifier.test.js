// test/outcome-classifier.test.js
//
// Typed probe outcomes — even failures are signal. Precedence: error >
// rate-limited > blocked > success/sanitized (marker) > inconclusive.

const assert = require('node:assert')
const { test } = require('node:test')
const { classifyOutcome, tallyOutcomes, OUTCOMES } = require('../src/pipeline/outcome-classifier')

test('error wins over everything', () => {
  assert.strictEqual(classifyOutcome({ error: 'ETIMEDOUT', status: 200, markerPresent: true }), 'error')
})

test('rate-limited: 429 or body signature', () => {
  assert.strictEqual(classifyOutcome({ status: 429 }), 'rate-limited')
  assert.strictEqual(classifyOutcome({ status: 200, body: 'Too Many Requests, slow down' }), 'rate-limited')
})

test('blocked: 403/406/401 or WAF signature', () => {
  assert.strictEqual(classifyOutcome({ status: 403 }), 'blocked')
  assert.strictEqual(classifyOutcome({ status: 200, body: 'Cloudflare cf-mitigated challenge' }), 'blocked')
  assert.strictEqual(classifyOutcome({ status: 200, body: 'Imperva incident id: 123' }), 'blocked')
  assert.strictEqual(classifyOutcome({ status: 200, body: 'Access Denied by WAF' }), 'blocked')
})

test('success when the marker executed/reflected', () => {
  assert.strictEqual(classifyOutcome({ status: 200, body: '...NONCE123...', markerPresent: true }), 'success')
})

test('sanitized: 200, no block, marker absent', () => {
  assert.strictEqual(classifyOutcome({ status: 200, body: 'ok, nothing reflected', markerPresent: false }), 'sanitized')
})

test('inconclusive when we cannot tell', () => {
  assert.strictEqual(classifyOutcome({ status: 200, body: 'normal page' }), 'inconclusive')
  assert.strictEqual(classifyOutcome({}), 'inconclusive')
})

test('block signature beats an unknown marker', () => {
  // 403 + marker unknown → blocked, not inconclusive
  assert.strictEqual(classifyOutcome({ status: 403, body: 'forbidden' }), 'blocked')
})

test('tallyOutcomes counts by class', () => {
  const counts = tallyOutcomes([
    { status: 403 }, { status: 429 }, { status: 200, markerPresent: true }, { status: 200, markerPresent: false },
  ])
  assert.strictEqual(counts.blocked, 1)
  assert.strictEqual(counts['rate-limited'], 1)
  assert.strictEqual(counts.success, 1)
  assert.strictEqual(counts.sanitized, 1)
  assert.deepStrictEqual(Object.keys(counts).sort(), [...OUTCOMES].sort())
})
