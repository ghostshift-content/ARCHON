'use strict'
// Unified task lifecycle (SPEC §5).
const { test } = require('node:test'); const assert = require('node:assert/strict')
const S = require('../src/runtime/task-state')
test('§5 happy path transitions', () => {
  assert.ok(S.canTransition('DISCOVERED', 'READY'))
  assert.ok(S.canTransition('READY', 'CLAIMED'))
  assert.ok(S.canTransition('CLAIMED', 'RUNNING'))
  assert.ok(S.canTransition('RUNNING', 'CANDIDATE_EMITTED'))
  assert.ok(S.canTransition('CANDIDATE_EMITTED', 'COMPLETED'))
})
test('§5 must claim before running; terminal is terminal', () => {
  assert.ok(!S.canTransition('READY', 'RUNNING'))
  assert.ok(!S.canTransition('COMPLETED', 'RUNNING'))
  assert.throws(() => S.transition('COMPLETED', 'RUNNING'))
})
test('§5 lease expiry + retryable re-queue', () => {
  assert.ok(S.canTransition('CLAIMED', 'READY'), 'lease expiry')
  assert.ok(S.canTransition('FAILED_RETRYABLE', 'READY'), 'retry')
  assert.ok(!S.isTerminal('FAILED_RETRYABLE') && S.isTerminal('FAILED_FINAL'))
})
test('§5 terminal set', () => {
  for (const t of ['COMPLETED', 'NO_ISSUE', 'BLOCKED', 'FAILED_FINAL', 'OUT_OF_SCOPE', 'DUPLICATE', 'DISPROVEN']) assert.ok(S.isTerminal(t))
  for (const a of ['DISCOVERED', 'READY', 'CLAIMED', 'RUNNING', 'CANDIDATE_EMITTED', 'FAILED_RETRYABLE']) assert.ok(S.isActive(a))
})
