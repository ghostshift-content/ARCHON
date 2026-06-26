// test/learning-loop.test.js
// Unit tests for agents/learning-loop.js
// Run: bun test test/learning-loop.test.js
//
// Focuses on PURE functions (distill + propose) — NO real file I/O for those.
// runLoop test uses DI outDir for isolation.

'use strict'

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'learning-loop-test-'))
}

function loadModule() {
  // Clear module cache to ensure fresh state
  const modPath = require.resolve('../agents/learning-loop')
  delete require.cache[modPath]
  // Also clear episode-record cache so readEpisodes starts fresh
  try {
    const epPath = require.resolve('../agents/episode-record')
    delete require.cache[epPath]
  } catch {}
  // Also clear quality-tracker cache
  try {
    const qtPath = require.resolve('../agents/quality-tracker')
    delete require.cache[qtPath]
  } catch {}
  return require('../agents/learning-loop')
}

// ---------------------------------------------------------------------------
// Test 1: distill with empty episodes → {patterns: [], alerts: []}
// ---------------------------------------------------------------------------

test('distill with empty episodes returns empty patterns and alerts', async () => {
  const ll = loadModule()

  const result = ll.distill({ episodes: [], baseline: { runs: 0 } })
  assert.ok(Array.isArray(result.patterns), 'patterns should be an array')
  assert.ok(Array.isArray(result.alerts), 'alerts should be an array')
  assert.strictEqual(result.patterns.length, 0, 'patterns should be empty')
  assert.strictEqual(result.alerts.length, 0, 'alerts should be empty')
})

// ---------------------------------------------------------------------------
// Test 2: distill with 3 failures for same agent → detects recurring-failure pattern
// ---------------------------------------------------------------------------

test('distill detects recurring-failure pattern when same agent fails ≥3 times', async () => {
  const ll = loadModule()

  const ts = new Date().toISOString()
  const episodes = [
    { epVersion: '1', ts, taskId: 't1', squad: 'pentest', agentName: 'SCOUT', phase: 'specialist', outcome: 'failed', gradeScore: 0.2, costUsd: 0.05, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: 'error' },
    { epVersion: '1', ts, taskId: 't2', squad: 'pentest', agentName: 'SCOUT', phase: 'specialist', outcome: 'failed', gradeScore: 0.1, costUsd: 0.05, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: 'error' },
    { epVersion: '1', ts, taskId: 't3', squad: 'pentest', agentName: 'SCOUT', phase: 'specialist', outcome: 'failed', gradeScore: 0.0, costUsd: 0.05, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: 'error' },
  ]

  const result = ll.distill({ episodes, baseline: { runs: 3 } })
  assert.ok(result.patterns.length >= 1, 'should detect at least one pattern')

  const failPattern = result.patterns.find(p => p.type === 'recurring-failure')
  assert.ok(failPattern, 'should detect recurring-failure pattern')
  assert.strictEqual(failPattern.agentName, 'SCOUT')
  assert.strictEqual(failPattern.count, 3)
})

// ---------------------------------------------------------------------------
// Test 3: distill with high-cost episodes → detects cost-outlier
// ---------------------------------------------------------------------------

test('distill detects cost-outlier when an agent cost > 2× its OWN historical avg (per-agent baseline 2026-06-09)', async () => {
  const ll = loadModule()

  const ts = new Date().toISOString()
  const mk = (agent, cost, t) => ({ epVersion: '1', ts, taskId: t, squad: 'pentest', agentName: agent, phase: 'specialist', outcome: 'completed', gradeScore: 0.8, costUsd: cost, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null })
  const episodes = [
    // VIPER's own 3-run history: two normal + one spike (5.00 > 2× its 1.74 avg)
    mk('VIPER', 0.10, 't1'), mk('VIPER', 0.12, 't2'), mk('VIPER', 5.00, 't3'),
    // RELAY: a single (high) run — must NOT be flagged (no own baseline, < min sample)
    mk('RELAY', 9.00, 't4'),
  ]

  const result = ll.distill({ episodes, baseline: {} })
  const costPattern = result.patterns.find(p => p.type === 'cost-outlier')
  assert.ok(costPattern, 'should detect cost-outlier pattern')
  assert.strictEqual(costPattern.agentName, 'VIPER')
  // Per-agent baseline: a single-run agent (RELAY) cannot be a cost-outlier vs itself.
  assert.ok(!result.patterns.find(p => p.type === 'cost-outlier' && p.agentName === 'RELAY'),
    'single-run agent must not be flagged (no own historical baseline)')
})

// ---------------------------------------------------------------------------
// Test 4: propose with empty patterns → []
// ---------------------------------------------------------------------------

test('propose with empty patterns returns empty array', async () => {
  const ll = loadModule()

  const result = ll.propose({ patterns: [] })
  assert.ok(Array.isArray(result), 'should return array')
  assert.strictEqual(result.length, 0, 'should be empty for empty patterns')
})

// ---------------------------------------------------------------------------
// Test 5: propose with a pattern → proposal has structuredAction (full-auto)
// ---------------------------------------------------------------------------

test('propose with a recurring-failure pattern produces proposal with structuredAction', async () => {
  const ll = loadModule()

  const patterns = [{
    type: 'recurring-failure',
    agentName: 'SCOUT',
    squad: 'pentest',
    count: 3,
    description: 'SCOUT failed 3 times in the observation window',
  }]

  const proposals = ll.propose({ patterns })
  assert.ok(proposals.length >= 1, 'should generate at least one proposal')
  assert.ok('structuredAction' in proposals[0], 'proposal should have a structuredAction field')
  assert.ok(proposals[0].structuredAction, 'structuredAction should be non-null for squad-backed pattern')
  const VALID_KINDS = ['squad_config_patch', 'soul_md_append', 'agent_model_override']
  assert.ok(VALID_KINDS.includes(proposals[0].structuredAction.kind),
    `structuredAction.kind should be one of ${VALID_KINDS.join('/')}, got: ${proposals[0].structuredAction.kind}`)
  assert.ok(proposals[0].suggestedAction, 'proposal should have a suggestedAction text')
  assert.ok(proposals[0].type, 'proposal should have a type')
})

// ---------------------------------------------------------------------------
// Test 6: propose invariant — all proposals have structuredAction key
// ---------------------------------------------------------------------------

test('propose INVARIANT: all proposals have structuredAction; config/routing changes require human tap (2026-06-09)', async () => {
  const ll = loadModule()

  const patterns = [
    { type: 'recurring-failure', agentName: 'SCOUT', squad: 'pentest', count: 3, description: 'desc' },
    { type: 'cost-outlier', agentName: 'VIPER', squad: 'stocks', count: 1, description: 'desc' },
    { type: 'low-grade', agentName: 'RELAY', squad: 'cloud-security', count: 3, description: 'desc' },
    { type: 'unknown-pattern', agentName: 'X', count: 1, description: 'desc' },
  ]

  const proposals = ll.propose({ patterns })
  assert.ok(proposals.length > 0, 'should generate proposals')

  for (const proposal of proposals) {
    assert.ok('structuredAction' in proposal,
      `proposal missing structuredAction field for ${proposal.agentName}`)
    // GATE-139: high-stakes config/routing changes are human-tap; low-risk lesson appends auto.
    const kind = proposal.structuredAction && proposal.structuredAction.kind
    if (kind === 'squad_config_patch' || kind === 'agent_model_override') {
      assert.strictEqual(proposal.requiresHumanTap, true,
        `config/routing proposal (${kind}) must require human tap — found in ${proposal.agentName}`)
    } else {
      assert.strictEqual(proposal.requiresHumanTap, false,
        `low-risk proposal (${kind}) should be auto-eligible (requiresHumanTap:false) — found in ${proposal.agentName}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Test 7: runLoop with DI outDir + empty state → {observed:0, patterns:0, proposals:0, applied:0}
// ---------------------------------------------------------------------------

test('runLoop with empty state returns correct summary (full-auto shape)', async () => {
  const ll = loadModule()
  const outDir = makeTempDir()

  const result = await ll.runLoop({ squad: 'pentest', windowDays: 7, outDir })

  assert.strictEqual(result.observed, 0, 'observed should be 0 when no episodes')
  assert.strictEqual(result.patterns, 0, 'patterns should be 0 when no episodes')
  assert.strictEqual(result.proposals, 0, 'proposals should be 0 when no patterns')
  assert.ok('applied' in result, 'runLoop result should have applied field (not humanTapRequired)')
  assert.ok(!('humanTapRequired' in result), 'runLoop result must not have humanTapRequired (full-auto)')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 8: distill is a pure function — no file I/O (calling it twice with same
//         input produces same output regardless of file system state)
// ---------------------------------------------------------------------------

test('distill is a pure function (deterministic, no I/O side-effects)', async () => {
  const ll = loadModule()

  const ts = new Date().toISOString()
  const episodes = [
    { epVersion: '1', ts, taskId: 't1', squad: 'pentest', agentName: 'SCOUT', phase: 'specialist', outcome: 'failed', gradeScore: 0.2, costUsd: 0.05, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null },
    { epVersion: '1', ts, taskId: 't2', squad: 'pentest', agentName: 'SCOUT', phase: 'specialist', outcome: 'failed', gradeScore: 0.1, costUsd: 0.05, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null },
    { epVersion: '1', ts, taskId: 't3', squad: 'pentest', agentName: 'SCOUT', phase: 'specialist', outcome: 'failed', gradeScore: 0.0, costUsd: 0.05, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null },
  ]

  const result1 = ll.distill({ episodes, baseline: {} })
  const result2 = ll.distill({ episodes, baseline: {} })

  assert.strictEqual(result1.patterns.length, result2.patterns.length, 'distill is deterministic')
  assert.strictEqual(result1.patterns[0].type, result2.patterns[0].type)
  assert.strictEqual(result1.patterns[0].agentName, result2.patterns[0].agentName)
})
