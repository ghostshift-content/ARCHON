'use strict'
// Unified task lifecycle (SPEC §5) — ONE state machine for black-box, static, and white-box tasks on the shared
// board. Pure + deterministic. Mapping-state and review-state are SEPARATE tasks (each runs this lifecycle
// independently) so a failed review never erases completed mapping.
//
//   DISCOVERED → READY → CLAIMED → RUNNING → CANDIDATE_EMITTED → COMPLETED
// Terminals: NO_ISSUE · BLOCKED · FAILED_FINAL · OUT_OF_SCOPE · DUPLICATE · DISPROVEN · COMPLETED
// FAILED_RETRYABLE is NON-terminal (retries back to READY).

const STATES = ['DISCOVERED', 'READY', 'CLAIMED', 'RUNNING', 'CANDIDATE_EMITTED', 'COMPLETED',
  'NO_ISSUE', 'BLOCKED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'OUT_OF_SCOPE', 'DUPLICATE', 'DISPROVEN']

const TERMINAL = new Set(['COMPLETED', 'NO_ISSUE', 'BLOCKED', 'FAILED_FINAL', 'OUT_OF_SCOPE', 'DUPLICATE', 'DISPROVEN'])

// legal transitions (from → allowed set)
const TRANSITIONS = {
  DISCOVERED: ['READY', 'OUT_OF_SCOPE', 'DUPLICATE'],
  READY: ['CLAIMED', 'OUT_OF_SCOPE'],
  CLAIMED: ['RUNNING', 'READY'],                         // READY = release / lease expiry (work-stealable again)
  RUNNING: ['CANDIDATE_EMITTED', 'COMPLETED', 'NO_ISSUE', 'BLOCKED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'DISPROVEN', 'READY'],
  CANDIDATE_EMITTED: ['RUNNING', 'COMPLETED', 'DUPLICATE', 'DISPROVEN'], // may emit more, then complete
  FAILED_RETRYABLE: ['READY', 'FAILED_FINAL'],           // retry, or give up
}

function isTerminal(s) { return TERMINAL.has(s) }
function isActive(s) { return STATES.includes(s) && !TERMINAL.has(s) }
function canTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) return false
  if (from === to) return true // idempotent re-write of the same state is allowed
  return (TRANSITIONS[from] || []).includes(to)
}
// apply a transition; throws on an illegal one (callers guard with canTransition for fail-soft)
function transition(from, to) {
  if (!canTransition(from, to)) throw new Error(`illegal task transition ${from} → ${to}`)
  return to
}

module.exports = { STATES, TERMINAL, TRANSITIONS, isTerminal, isActive, canTransition, transition }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  assert.ok(canTransition('DISCOVERED', 'READY') && canTransition('READY', 'CLAIMED') && canTransition('CLAIMED', 'RUNNING'))
  assert.ok(canTransition('RUNNING', 'CANDIDATE_EMITTED') && canTransition('CANDIDATE_EMITTED', 'COMPLETED'))
  assert.ok(canTransition('CLAIMED', 'READY'), 'lease expiry releases back to READY')
  assert.ok(canTransition('FAILED_RETRYABLE', 'READY'), 'retryable failures re-queue')
  assert.ok(!canTransition('COMPLETED', 'RUNNING'), 'terminal is terminal')
  assert.ok(!canTransition('READY', 'RUNNING'), 'must claim before running')
  assert.ok(isTerminal('DISPROVEN') && !isTerminal('FAILED_RETRYABLE') && isActive('CLAIMED'))
  console.log('ok — task-state: unified §5 lifecycle, legal transitions, terminal gate')
}
