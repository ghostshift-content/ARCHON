#!/usr/bin/env node
// Unit tests for quarantineThrashFiles — prevents bogus completion files
// (written by agents during thinking-thrash) from contaminating downstream
// VYASA phase. Regression guard for Apr-21 Run 1 hallucinations.
// Run: node /root/agents/test/quarantine-thrash.test.js

const fs = require('fs')
const path = require('path')
const { quarantineThrashFiles } = require('../src/safety/thrash-quarantine')

let passed = 0, failed = 0
function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}`); failed++ }
}

console.log('quarantineThrashFiles tests:')

const TMP = '/tmp/test-quarantine-' + process.pid
const PENTEST = path.join(TMP, 'pentest')
fs.mkdirSync(PENTEST, { recursive: true })

try {
  // Scenario 1: thrashing ARJUN wrote 3 bogus completion files — quarantine them.
  fs.writeFileSync(path.join(PENTEST, 'DELIVERY-REPORT-RALPH-LOOP-RUN-1.md'), 'fake completion')
  fs.writeFileSync(path.join(PENTEST, 'RUN-1-SUMMARY.md'), 'fake run summary')
  fs.writeFileSync(path.join(PENTEST, 'ARJUN-phantom-output.md'), 'hallucinated data tagged by agent name')
  fs.writeFileSync(path.join(PENTEST, 'real-recon-by-sibling.md'), 'legitimate output from another agent')

  const silentSince = Date.now() - 60000 // 1 min ago — files above have current mtime > this
  const moved1 = quarantineThrashFiles(PENTEST, 'TASK123', 'ARJUN', silentSince)

  ok('moves DELIVERY-REPORT bogus file', !fs.existsSync(path.join(PENTEST, 'DELIVERY-REPORT-RALPH-LOOP-RUN-1.md')))
  ok('moves RUN-N-SUMMARY bogus file',  !fs.existsSync(path.join(PENTEST, 'RUN-1-SUMMARY.md')))
  ok('moves ARJUN-tagged output file',  !fs.existsSync(path.join(PENTEST, 'ARJUN-phantom-output.md')))
  ok('leaves sibling agent real output alone', fs.existsSync(path.join(PENTEST, 'real-recon-by-sibling.md')))
  ok('quarantine dir created under pentest/quarantine/<taskId>', fs.existsSync(path.join(PENTEST, 'quarantine', 'TASK123')))
  ok('returns correct moved count (3)', moved1 === 3)

  // Scenario 2: files that pre-date silentSince must NOT be quarantined.
  fs.writeFileSync(path.join(PENTEST, 'DELIVERY-old.md'), 'legitimate from earlier phase')
  const oldTs = (Date.now() - 3600000) / 1000 // 1 hour ago
  fs.utimesSync(path.join(PENTEST, 'DELIVERY-old.md'), oldTs, oldTs)
  const moved2 = quarantineThrashFiles(PENTEST, 'TASK123', 'ARJUN', silentSince)
  ok('does NOT move files predating silentSince', fs.existsSync(path.join(PENTEST, 'DELIVERY-old.md')))
  ok('returns 0 when no new candidates exist', moved2 === 0)

  // Scenario 3: empty agent name — pattern-match only.
  fs.writeFileSync(path.join(PENTEST, 'COMPLETE-SUMMARY.md'), 'fake')
  const moved3 = quarantineThrashFiles(PENTEST, 'TASK999', '', silentSince)
  ok('quarantines pattern-match even with empty agentName', !fs.existsSync(path.join(PENTEST, 'COMPLETE-SUMMARY.md')))
  ok('returns 1 for COMPLETE-SUMMARY match', moved3 === 1)

  // Scenario 4: files in subdirectories are untouched.
  const findingsDir = path.join(PENTEST, 'findings')
  fs.mkdirSync(findingsDir, { recursive: true })
  fs.writeFileSync(path.join(findingsDir, 'DELIVERY-REPORT.md'), 'in subdir — leave alone')
  const moved4 = quarantineThrashFiles(PENTEST, 'TASK999', 'ARJUN', silentSince)
  ok('does NOT recurse into subdirectories', fs.existsSync(path.join(findingsDir, 'DELIVERY-REPORT.md')))
  ok('returns 0 for subdir-only candidates', moved4 === 0)
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
