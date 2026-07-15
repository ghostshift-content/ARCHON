'use strict'
// Mode-adapter interface (SPEC §2) — per-mode confirmation + unit.
const { test } = require('node:test'); const assert = require('node:assert/strict')
const A = require('../src/runtime/mode-adapter')
test('three adapters registered with required fields', () => {
  assert.deepEqual(A.modes().sort(), ['blackbox', 'static', 'whitebox'])
  for (const m of A.modes()) for (const k of A.REQUIRED) assert.ok(k in A.get(m), `${m}.${k}`)
})
test('static never RUNTIME_CONFIRMED', () => {
  assert.equal(A.get('static').confirm('RUNTIME_CONFIRMED'), 'SOURCE_CONFIRMED')
  assert.equal(A.get('static').confirm('DISPROVEN'), 'DISPROVEN')
  assert.equal(A.get('static').workstreamUnit, 'source_domain')
})
test('black-box confirms only with runtime proof; is dynamic', () => {
  assert.equal(A.get('blackbox').confirm('x', true), 'RUNTIME_CONFIRMED')
  assert.equal(A.get('blackbox').confirm('x', false), 'NEEDS_LIVE_VALIDATION')
  assert.ok(A.get('blackbox').dynamic)
})
test('white-box upgrades ONLY with linked runtime proof', () => {
  assert.equal(A.get('whitebox').confirm('RUNTIME_CONFIRMED', false), 'SOURCE_CONFIRMED')
  assert.equal(A.get('whitebox').confirm('RUNTIME_CONFIRMED', true), 'RUNTIME_CONFIRMED')
})
test('defineAdapter rejects an incomplete adapter', () => {
  assert.throws(() => A.defineAdapter({ mode: 'x' }))
})
