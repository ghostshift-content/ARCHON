// test/event-bus-phase-a3-async.test.js
//
// Module-level grep tests confirming Phase A3 of runtracerAgent uses the
// async runWithHeartbeat wrapper instead of blocking sync subprocess. Catches
// accidental regression that would re-introduce the supervisor SIGKILL bug.
//
// Spec: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md (Task 2)

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

function sliceRuntracerAgent() {
  const start = SRC.indexOf('async function runtracerAgent')
  assert.ok(start > 0, 'runtracerAgent function must be present')
  return SRC.slice(start, start + 8000)
}

function slicePhaseA3() {
  const fn = sliceRuntracerAgent()
  // Capture from "Phase A3:" through the next "Phase B" header so all branches
  // of the try block are visible (success log, timeout log, exit-code log,
  // catch handler). Falls back to a generous fixed window if Phase B isn't found.
  const m = fn.match(/Phase A3:[\s\S]{0,4000}?(?:\bPhase B\b|\bdiscovered\s*=\s*new Set)/) ||
            fn.match(/Phase A3:[\s\S]{0,4000}/)
  assert.ok(m, 'Phase A3 block must be present in runtracerAgent')
  return m[0]
}

test('runtracerAgent imports runWithHeartbeat from long-running-spawn', () => {
  const slice = sliceRuntracerAgent()
  assert.match(slice, /require\(['"]\.\/agents\/long-running-spawn['"]\)/,
    'must require ./agents/long-running-spawn')
  assert.match(slice, /\brunWithHeartbeat\b/,
    'must reference runWithHeartbeat')
})

test('Phase A3 uses runWithHeartbeat (not blocking sync subprocess)', () => {
  const block = slicePhaseA3()
  assert.match(block, /\bawait\s+runWithHeartbeat\b/,
    'Phase A3 must use await runWithHeartbeat')
  // Regression guard: blocking sync forms must not appear in the Phase A3 block
  assert.doesNotMatch(block, /\bexecSync\s*\(/,
    'Phase A3 must NOT use execSync (regression guard)')
  assert.doesNotMatch(block, /\bspawnSync\s*\(/,
    'Phase A3 must NOT use spawnSync (regression guard)')
})

test('Phase A3 passes persistCheckpointNow as heartbeat callback', () => {
  const block = slicePhaseA3()
  assert.match(block, /onHeartbeat\s*:\s*persistCheckpointNow|onHeartbeat\s*:\s*\(\s*\)\s*=>\s*persistCheckpointNow/,
    'Phase A3 must pass persistCheckpointNow as the onHeartbeat callback')
})

test('Phase A3 keeps the fail-soft try/catch wrapper', () => {
  const block = slicePhaseA3()
  assert.match(block, /crawl4ai error.*continuing with light crawl/,
    'fail-soft warn-and-continue log line must still print')
})

test('Phase A3 still produces "crawl4ai output:" log line', () => {
  const block = slicePhaseA3()
  assert.match(block, /crawl4ai output:/,
    'log line that downstream tooling/ops watches for must still print')
})
