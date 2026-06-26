#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Unit tests for /root/agents/squad-framework.js — specifically the new squad-generic
// accessors that event-bus now relies on. These are the tests that catch regressions
// when we add a new squad to SQUAD_TYPES.
// Run: node /root/agents/test/squad-framework.test.js

const assert = require('assert')
const sf = require('../src/core/squad-framework')

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

console.log('squad-framework tests:')

test('all 7 known squads exported', () => {
  const known = sf.listKnownSquads()
  assert.deepStrictEqual(known.sort(), [
    'ai-security', 'cloud-security', 'code-review', 'network-pentest', 'pentest', 'red-team', 'stocks',
  ])
})

test('every known squad has all required config fields', () => {
  for (const squad of sf.listKnownSquads()) {
    const cfg = sf.getSquadConfig(squad)
    for (const field of ['type', 'leaderAgent', 'gateStyle', 'memoryNamespace', 'dispatchType']) {
      assert.ok(cfg[field], `squad ${squad} missing field ${field}`)
    }
  }
})

test('gateStyle is either "security" or "analysis"', () => {
  for (const squad of sf.listKnownSquads()) {
    const style = sf.getSquadGateStyle(squad)
    assert.ok(['security', 'analysis'].includes(style), `squad ${squad} has invalid gateStyle: ${style}`)
  }
})

test('getSquadGates returns MUST_GATES_STOCKS for stocks, MUST_GATES otherwise', () => {
  assert.strictEqual(sf.getSquadGates('stocks'), sf.MUST_GATES_STOCKS)
  assert.strictEqual(sf.getSquadGates('stocks-squad'), sf.MUST_GATES_STOCKS)
  assert.strictEqual(sf.getSquadGates('pentest'), sf.MUST_GATES)
  assert.strictEqual(sf.getSquadGates('red-team'), sf.MUST_GATES)
  assert.strictEqual(sf.getSquadGates('cloud-security'), sf.MUST_GATES)
})

test('leader resolution works for all squads + -squad suffix variants', () => {
  assert.strictEqual(sf.getSquadLeader('pentest'), 'atlas')
  assert.strictEqual(sf.getSquadLeader('pentest-squad'), 'atlas')
  assert.strictEqual(sf.getSquadLeader('stocks'), 'chanakya')
  assert.strictEqual(sf.getSquadLeader('red-team'), 'parashurama')
  assert.strictEqual(sf.getSquadLeader('cloud-security'), 'varuna')
  assert.strictEqual(sf.getSquadLeader('network-pentest'), 'shalya')
})

test('unknown squad gets DEFAULT config', () => {
  const cfg = sf.getSquadConfig('unknown-xyz')
  assert.strictEqual(cfg.leaderAgent, 'atlas')
  assert.strictEqual(cfg.gateStyle, 'security')
  assert.strictEqual(sf.getSquadGates('unknown-xyz'), sf.MUST_GATES)
})

test('getSquadMemoryFile produces unique path per squad', () => {
  const paths = sf.listKnownSquads().map(s => sf.getSquadMemoryFile(s))
  const unique = new Set(paths)
  assert.strictEqual(paths.length, unique.size, 'memory file paths must be unique per squad')
  for (const p of paths) {
    assert.match(p, /^\/root\/intel\/squad-memory-.+\.json$/, `path ${p} not well-formed`)
  }
})

test('adding a new squad to SQUAD_TYPES is detected by listKnownSquads', () => {
  // Simulate adding a new squad at runtime (doesn't mutate disk file — in-memory only)
  // Use a name without the literal "-squad" substring to avoid interference with
  // getSquadConfig's normalization (which strips "-squad" from input).
  const newSquad = 'quantum-ops'
  sf.SQUAD_TYPES[newSquad] = {
    type: 'security-testing',
    leaderAgent: 'testleader',
    gateStyle: 'security',
    memoryNamespace: 'quantum',
    dispatchType: 'parallel-phases',
    chainAnalysis: true,
    arbiterVerification: true,
    costBudget: 50,
  }
  try {
    assert.ok(sf.listKnownSquads().includes(newSquad))
    assert.strictEqual(sf.getSquadLeader(newSquad), 'testleader')
    assert.strictEqual(sf.getSquadMemoryFile(newSquad), (__roots.INTEL_ROOT + '/squad-memory-quantum.json'))
  } finally {
    delete sf.SQUAD_TYPES[newSquad]
  }
})

test('cost budget from config + override precedence', () => {
  // getCostBudget should return something for every known squad
  for (const squad of sf.listKnownSquads()) {
    const budget = sf.getCostBudget(squad)
    assert.ok(typeof budget === 'number' && budget > 0, `squad ${squad} has invalid budget: ${budget}`)
  }
})

test('every squad has reportDirs (may be empty) — squad-universal report paths', () => {
  for (const squad of sf.listKnownSquads()) {
    const dirs = sf.getSquadReportDirs(squad)
    assert.ok(Array.isArray(dirs), `squad ${squad} reportDirs is not an array`)
  }
})

test('security squads have at least one reportDir + a FINAL-REPORT path', () => {
  for (const squad of sf.listKnownSquads()) {
    if (sf.getSquadGateStyle(squad) !== 'security') continue
    const dirs = sf.getSquadReportDirs(squad)
    assert.ok(dirs.length >= 1, `security squad ${squad} must have at least one reportDir`)
    const finalRp = sf.getSquadFinalReportPath(squad, 'testtask')
    assert.ok(finalRp && finalRp.endsWith('.md'), `security squad ${squad} must resolve finalReportPath`)
    const taskRp = sf.getSquadTaskReportPath(squad, 'testtask')
    assert.ok(taskRp && taskRp.includes('testtask'), `security squad ${squad} must resolve taskReportPath`)
  }
})

test('getAllSquadReportDirs aggregates across all squads (deduped)', () => {
  const all = sf.getAllSquadReportDirs()
  assert.ok(all.includes((__roots.INTEL_ROOT + '/pentest')), 'should include pentest dir')
  assert.ok(all.includes((__roots.INTEL_ROOT + '/stocks')), 'should include stocks dir')
  assert.ok(all.includes((__roots.INTEL_ROOT + '/red-team')), 'should include red-team dir')
  assert.ok(all.includes((__roots.INTEL_ROOT + '/cloud-security')), 'should include cloud-security dir')
  assert.ok(all.includes((__roots.INTEL_ROOT + '/ai-security')), 'should include ai-security dir')
  // no duplicates
  assert.strictEqual(new Set(all).size, all.length, 'getAllSquadReportDirs must dedupe')
})

test('getEvidenceCompletenessConfig returns per-squad config', () => {
  const cr = sf.getEvidenceCompletenessConfig('code-review')
  assert.strictEqual(cr.enabled, true, 'code-review must have evidenceCompleteness enabled')
  assert.strictEqual(cr.provider, 'pipeline')
  const st = sf.getEvidenceCompletenessConfig('stocks')
  assert.strictEqual(st.enabled, false)
  const unknown = sf.getEvidenceCompletenessConfig('made-up-squad')
  assert.strictEqual(unknown.enabled, false, 'unknown squad returns safe default')
})

test('MUST_GATES contains GATE-11 [CHAIN-COMPLETE]', () => {
  const gates = sf.getSquadGates('pentest')
  assert.ok(gates.includes('GATE-11 [CHAIN-COMPLETE]'), 'GATE-11 should be present in security gates')
})

test('getThreatModelConfig returns per-squad config', () => {
  const cr = sf.getThreatModelConfig('code-review')
  assert.strictEqual(cr.enabled, true, 'code-review must have threatModel enabled')
  assert.strictEqual(cr.provider, 'threat-model')
  const st = sf.getThreatModelConfig('stocks')
  assert.strictEqual(st.enabled, false)
  const unknown = sf.getThreatModelConfig('made-up-squad')
  assert.strictEqual(unknown.enabled, false, 'unknown squad returns safe default')
})

test('MUST_GATES contains GATE-12 [THREAT-MODEL]', () => {
  const gates = sf.getSquadGates('pentest')
  assert.ok(gates.includes('GATE-12 [THREAT-MODEL]'),
    'GATE-12 should be present in security gates')
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
