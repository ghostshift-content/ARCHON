// test/goal-evaluator.test.js
// Unit tests for agents/goal-evaluator.js
// Run: bun test test/goal-evaluator.test.js
//
// Tests the oracle-anchored convergence evaluator.
// Uses _runAgent DI to avoid real LLM calls.

'use strict'

const assert = require('node:assert')
const { test } = require('node:test')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadModule() {
  const modPath = require.resolve('../agents/goal-evaluator')
  delete require.cache[modPath]
  // Also clear early-exit-decision from cache for isolation
  try {
    const eedPath = require.resolve('../early-exit-decision')
    delete require.cache[eedPath]
  } catch {}
  return require('../agents/goal-evaluator')
}

// ---------------------------------------------------------------------------
// Test 1: heuristic CONTINUE → shouldExit:false, oracleUsed:false, no runAgent called
// ---------------------------------------------------------------------------

test('heuristic CONTINUE → shouldExit:false, oracleUsed:false, runAgent never called', async () => {
  const { evaluateConvergence } = loadModule()

  let runAgentCalled = false
  const _runAgent = async () => {
    runAgentCalled = true
    return { text: 'CONTINUE' }
  }

  // endpointCount=1 → CONTINUE
  const result = await evaluateConvergence({
    endpointCount: 1,
    targetReachable: true,
    missedSignalsCount: 0,
    existingFindingCount: 0,
    _runAgent,
  })

  assert.strictEqual(result.shouldExit, false, 'shouldExit should be false for CONTINUE')
  assert.strictEqual(result.oracleUsed, false, 'oracle should not be used on heuristic CONTINUE')
  assert.strictEqual(result.source, 'heuristic', 'source should be heuristic')
  assert.strictEqual(runAgentCalled, false, 'runAgent should NOT be called on heuristic CONTINUE')
})

// ---------------------------------------------------------------------------
// Test 2: heuristic EARLY_EXIT + existingFindingCount>0 → exits without oracle
// ---------------------------------------------------------------------------

test('heuristic EARLY_EXIT + existingFindingCount>0 → exit without oracle', async () => {
  const { evaluateConvergence } = loadModule()

  let runAgentCalled = false
  const _runAgent = async () => {
    runAgentCalled = true
    return { text: 'CONTINUE' }
  }

  // endpointCount=0, targetReachable=false, missedSignals=0 → EARLY_EXIT
  const result = await evaluateConvergence({
    endpointCount: 0,
    targetReachable: false,
    missedSignalsCount: 0,
    existingFindingCount: 5,  // has findings → skip oracle
    _runAgent,
  })

  assert.strictEqual(result.shouldExit, true, 'shouldExit should be true')
  assert.strictEqual(result.oracleUsed, false, 'oracle should not be consulted when findings > 0')
  assert.strictEqual(result.source, 'heuristic', 'source should be heuristic')
  assert.strictEqual(runAgentCalled, false, 'runAgent should NOT be called when existingFindingCount > 0')
})

// ---------------------------------------------------------------------------
// Test 3: EARLY_EXIT + findingCount=0 + oracle says CONTINUE → shouldExit:false, oracleUsed:true
// ---------------------------------------------------------------------------

test('EARLY_EXIT + findingCount=0 + oracle says CONTINUE → shouldExit:false, oracleUsed:true', async () => {
  const { evaluateConvergence } = loadModule()

  const _runAgent = async () => ({ text: 'CONTINUE' })

  const result = await evaluateConvergence({
    endpointCount: 0,
    targetReachable: false,
    missedSignalsCount: 0,
    existingFindingCount: 0,
    _runAgent,
  })

  assert.strictEqual(result.shouldExit, false, 'oracle CONTINUE should override heuristic EARLY_EXIT')
  assert.strictEqual(result.oracleUsed, true, 'oracle should be marked as used')
  assert.strictEqual(result.source, 'oracle', 'source should be oracle')
  assert.strictEqual(result.reason, 'oracle_override_continue', 'reason should be oracle_override_continue')
})

// ---------------------------------------------------------------------------
// Test 4: EARLY_EXIT + findingCount=0 + oracle says STOP → shouldExit:true, source:'both'
// ---------------------------------------------------------------------------

test('EARLY_EXIT + findingCount=0 + oracle says STOP → shouldExit:true, source:both', async () => {
  const { evaluateConvergence } = loadModule()

  const _runAgent = async () => ({ text: 'STOP' })

  const result = await evaluateConvergence({
    endpointCount: 0,
    targetReachable: false,
    missedSignalsCount: 0,
    existingFindingCount: 0,
    _runAgent,
  })

  assert.strictEqual(result.shouldExit, true, 'both heuristic+oracle say exit → shouldExit:true')
  assert.strictEqual(result.oracleUsed, true, 'oracle should be marked as used')
  assert.strictEqual(result.source, 'both', 'source should be both when both agree')
  assert.strictEqual(result.reason, 'heuristic_and_oracle_agree_exit', 'reason should indicate both agreed')
})

// ---------------------------------------------------------------------------
// Test 5: DI — _runAgent is called with the correct prompt when oracle path runs
// ---------------------------------------------------------------------------

test('DI: _runAgent is called with correct prompt structure when oracle path runs', async () => {
  const { evaluateConvergence } = loadModule()

  let capturedSpec = null
  const _runAgent = async (spec) => {
    capturedSpec = spec
    return { text: 'STOP' }
  }

  await evaluateConvergence({
    endpointCount: 0,
    targetReachable: false,
    missedSignalsCount: 2,
    existingFindingCount: 0,
    taskId: 'task-abc',
    _runAgent,
  })

  assert.ok(capturedSpec, '_runAgent should have been called')
  assert.ok(typeof capturedSpec.userPrompt === 'string', 'userPrompt should be a string')
  assert.ok(capturedSpec.userPrompt.includes('endpointCount=0'), 'prompt should include endpointCount')
  assert.ok(capturedSpec.userPrompt.includes('missedSignalsCount=2'), 'prompt should include missedSignalsCount')
  assert.ok(/STOP or CONTINUE/.test(capturedSpec.userPrompt), 'prompt should ask for STOP or CONTINUE')
  assert.strictEqual(capturedSpec.taskId, 'task-abc', 'taskId should be passed through')
})

// ---------------------------------------------------------------------------
// Test 6: EARLY_EXIT + no _runAgent → exit without oracle, oracleUsed:false
// ---------------------------------------------------------------------------

test('EARLY_EXIT + no _runAgent → exit without oracle', async () => {
  const { evaluateConvergence } = loadModule()

  // No _runAgent provided at all
  const result = await evaluateConvergence({
    endpointCount: 0,
    targetReachable: false,
    missedSignalsCount: 0,
    existingFindingCount: 0,
  })

  assert.strictEqual(result.shouldExit, true, 'should exit when oracle not available')
  assert.strictEqual(result.oracleUsed, false, 'oracleUsed should be false when no _runAgent')
  assert.strictEqual(result.source, 'heuristic', 'source should be heuristic')
})

// ---------------------------------------------------------------------------
// Test 7: CONVERGENCE_SOURCES exported correctly
// ---------------------------------------------------------------------------

test('CONVERGENCE_SOURCES exports the three valid source names', async () => {
  const { CONVERGENCE_SOURCES } = loadModule()

  assert.ok(Array.isArray(CONVERGENCE_SOURCES), 'CONVERGENCE_SOURCES should be an array')
  assert.ok(CONVERGENCE_SOURCES.includes('heuristic'), 'should include heuristic')
  assert.ok(CONVERGENCE_SOURCES.includes('oracle'), 'should include oracle')
  assert.ok(CONVERGENCE_SOURCES.includes('both'), 'should include both')
  assert.strictEqual(CONVERGENCE_SOURCES.length, 3, 'should have exactly 3 sources')
})

// ---------------------------------------------------------------------------
// Test 8: oracle failure (throws) → falls back to heuristic, fail-soft
// ---------------------------------------------------------------------------

test('oracle failure → falls back to heuristic decision, oracleUsed:false', async () => {
  const { evaluateConvergence } = loadModule()

  const _runAgent = async () => {
    throw new Error('network timeout')
  }

  const result = await evaluateConvergence({
    endpointCount: 0,
    targetReachable: false,
    missedSignalsCount: 0,
    existingFindingCount: 0,
    _runAgent,
  })

  assert.strictEqual(result.shouldExit, true, 'should exit on oracle failure (heuristic wins)')
  assert.strictEqual(result.oracleUsed, false, 'oracleUsed should be false on oracle error')
  assert.strictEqual(result.source, 'heuristic', 'source should be heuristic on oracle error')
})
