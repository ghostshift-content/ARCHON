#!/usr/bin/env node
// Unit tests for /root/agents/early-exit-decision.js
// Run: bun test test/early-exit-decision.test.js

const assert = require('assert')
const { shouldEarlyExit, MISSED_SIGNAL_THRESHOLD, decisions } = require('../src/pipeline/early-exit-decision')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

console.log('early-exit-decision tests:')

test('exposes the four decision constants', () => {
  assert.strictEqual(decisions.CONTINUE, 'CONTINUE')
  assert.strictEqual(decisions.CONTINUE_WITH_HINTS, 'CONTINUE_WITH_HINTS')
  assert.strictEqual(decisions.CONTINUE_WITH_HINTS_REACHCHECK, 'CONTINUE_WITH_HINTS_REACHCHECK')
  assert.strictEqual(decisions.EARLY_EXIT, 'EARLY_EXIT')
})

test('threshold is 3', () => {
  assert.strictEqual(MISSED_SIGNAL_THRESHOLD, 3)
})

test('endpoints > 0 → CONTINUE regardless of other signals', () => {
  const r = shouldEarlyExit({ endpointCount: 5, targetReachable: false, missedSignalsCount: 0 })
  assert.strictEqual(r.decision, 'CONTINUE')
  assert.strictEqual(r.reason, 'endpoints_found')
})

test('0 endpoints + reachable + 0 misses → CONTINUE (SPA path)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 0 })
  assert.strictEqual(r.decision, 'CONTINUE')
  assert.strictEqual(r.reason, 'target_reachable_no_endpoints')
})

test('0 endpoints + reachable + 3 misses → CONTINUE_WITH_HINTS (Gap 1 fix)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 3 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS')
  assert.strictEqual(r.reason, '3_missed_signals')
})

test('0 endpoints + reachable + 10 misses → CONTINUE_WITH_HINTS (politemail case)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 10 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS')
  assert.strictEqual(r.reason, '10_missed_signals')
})

test('0 endpoints + unreachable + 5 misses → CONTINUE_WITH_HINTS_REACHCHECK', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: false, missedSignalsCount: 5 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS_REACHCHECK')
  assert.strictEqual(r.reason, '5_signals_unreachable_recheck_scheme')
})

test('0 endpoints + unreachable + <3 misses → EARLY_EXIT (truly dead target)', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: false, missedSignalsCount: 0 })
  assert.strictEqual(r.decision, 'EARLY_EXIT')
  assert.strictEqual(r.reason, 'no_endpoints_unreachable_no_signals')
})

test('threshold edge: exactly 2 misses + reachable → CONTINUE without hints', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 2 })
  assert.strictEqual(r.decision, 'CONTINUE')
})

test('threshold edge: exactly 3 misses + reachable → CONTINUE_WITH_HINTS', () => {
  const r = shouldEarlyExit({ endpointCount: 0, targetReachable: true, missedSignalsCount: 3 })
  assert.strictEqual(r.decision, 'CONTINUE_WITH_HINTS')
})

test('default values when params omitted → EARLY_EXIT', () => {
  const r = shouldEarlyExit()
  assert.strictEqual(r.decision, 'EARLY_EXIT')
})

test('partial params: only endpointCount given → CONTINUE if positive', () => {
  const r = shouldEarlyExit({ endpointCount: 1 })
  assert.strictEqual(r.decision, 'CONTINUE')
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
