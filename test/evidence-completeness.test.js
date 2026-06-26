#!/usr/bin/env node
// Unit tests for evidence-completeness module — severity cap, schema validator,
// min-layers constants. Pure functions, no I/O.

const ec = require('../src/pipeline/evidence-completeness')

let passed = 0, failed = 0
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++ }
}

console.log('evidence-completeness tests:')

// Constants
ok('PIPELINE_MIN_LAYERS has all 7 squads', [
  'code-review', 'cloud-security', 'network-pentest',
  'pentest', 'red-team', 'stocks', 'ai-security',
].every(s => typeof ec.PIPELINE_MIN_LAYERS[s] === 'number'))
ok('code-review min = 3', ec.PIPELINE_MIN_LAYERS['code-review'] === 3)
ok('stocks min = 0', ec.PIPELINE_MIN_LAYERS['stocks'] === 0)

// Schema validator
const goodCandidate = {
  id: 'TEST-1', severity: 'High',
  evidence_completeness: 'full',
  pipeline_trace: ['router', 'middleware', 'controller'],
  upstream_defenses_checked: [{layer: 'middleware', outcome: 'none'}],
  runtime_verification_command: 'curl http://x',
  expected_true_positive_signature: 'HTTP 200 body contains X',
  expected_false_positive_signature: 'HTTP 404',
}
const r1 = ec.validateCandidateSchema(goodCandidate)
ok('valid candidate passes', r1.valid, JSON.stringify(r1.errors))

const missingEC = { ...goodCandidate }; delete missingEC.evidence_completeness
const r2 = ec.validateCandidateSchema(missingEC)
ok('missing evidence_completeness normalized to local_only', r2.valid && r2.normalized === 'local_only')

const badEC = { ...goodCandidate, evidence_completeness: 'bogus' }
const r3 = ec.validateCandidateSchema(badEC)
ok('bogus evidence_completeness rejected', !r3.valid)

const samesig = { ...goodCandidate, expected_false_positive_signature: goodCandidate.expected_true_positive_signature }
const r4 = ec.validateCandidateSchema(samesig)
ok('identical TP/FP signatures rejected', !r4.valid)

// capSeverity 3-tier
ok('full + Critical = Critical uncapped', ec.capSeverity('Critical', 'full').cappedSeverity === 'Critical' && !ec.capSeverity('Critical', 'full').wasCapped)
ok('partial + Critical = Medium (capped)', ec.capSeverity('Critical', 'partial').cappedSeverity === 'Medium' && ec.capSeverity('Critical', 'partial').wasCapped)
ok('partial + High = Medium (capped)', ec.capSeverity('High', 'partial').cappedSeverity === 'Medium' && ec.capSeverity('High', 'partial').wasCapped)
ok('partial + Low = Low (not capped up)', ec.capSeverity('Low', 'partial').cappedSeverity === 'Low' && !ec.capSeverity('Low', 'partial').wasCapped)
ok('local_only + Critical = Low', ec.capSeverity('Critical', 'local_only').cappedSeverity === 'Low')
ok('local_only + Medium = Low', ec.capSeverity('Medium', 'local_only').cappedSeverity === 'Low')
ok('unknown ec defaults to local_only cap', ec.capSeverity('Critical', 'bogus').cappedSeverity === 'Low')

// pipelineTraceMeetsMinimum
ok('code-review 3 layers meets min', ec.pipelineTraceMeetsMinimum(['a','b','c'], 'code-review'))
ok('code-review 2 layers fails min', !ec.pipelineTraceMeetsMinimum(['a','b'], 'code-review'))
ok('stocks always passes (min=0)', ec.pipelineTraceMeetsMinimum([], 'stocks'))
ok('unknown squad passes (no enforcement)', ec.pipelineTraceMeetsMinimum([], 'unknown-squad'))

// downgradeReason composition
const dr = ec.downgradeReason('Critical', 'Medium', 'partial', { trace_too_short: true, minLayers: 3, actualLayers: 1 })
ok('downgradeReason includes trace-too-short detail', dr.includes('partial') && dr.includes('Critical') && dr.includes('Medium') && dr.includes('trace_too_short'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
