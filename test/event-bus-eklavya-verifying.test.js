// test/event-bus-eklavya-verifying.test.js
//
// Module-level grep tests confirming runEklavyaAgent wraps the entire eklavya
// recon phase in checkpoint.verifying=true so supervisor.js uses its 15-min
// stale threshold instead of 5-min. Catches accidental regression that would
// re-introduce the daemon SIGKILL during long sync phases (Phase G3 etc).
//
// Spec: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md (Round 2)

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

test('runEklavyaAgent is the public wrapper, not the original 360-line body', () => {
  // The wrapper should be SHORT (under ~30 lines)
  const wrapperStart = SRC.indexOf('async function runEklavyaAgent(target, taskId) {')
  assert.ok(wrapperStart > 0, 'runEklavyaAgent must be present')
  const wrapperEnd = SRC.indexOf('}', wrapperStart + 50)
  // Find the matching closing brace by simple counting (this wrapper is small)
  let depth = 0
  let end = wrapperStart
  for (let i = wrapperStart; i < wrapperStart + 5000; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  const wrapperBody = SRC.slice(wrapperStart, end + 1)
  const wrapperLineCount = wrapperBody.split('\n').length
  assert.ok(wrapperLineCount < 30,
    `wrapper must be small (got ${wrapperLineCount} lines) — the actual body must be in _runEklavyaAgentInner`)
})

test('runEklavyaAgent wrapper sets persistCheckpointNow({verifying:true}) before inner call', () => {
  const wrapperStart = SRC.indexOf('async function runEklavyaAgent(target, taskId) {')
  const wrapperBody = SRC.slice(wrapperStart, wrapperStart + 2000)
  assert.match(wrapperBody, /persistCheckpointNow\s*\(\s*\{\s*verifying\s*:\s*true\s*\}/,
    'wrapper must call persistCheckpointNow({ verifying: true })')
})

test('runEklavyaAgent wrapper clears verifying flag in finally block', () => {
  const wrapperStart = SRC.indexOf('async function runEklavyaAgent(target, taskId) {')
  const wrapperBody = SRC.slice(wrapperStart, wrapperStart + 2000)
  assert.match(wrapperBody, /finally\s*\{[\s\S]{0,400}?persistCheckpointNow\s*\(\s*\{\s*verifying\s*:\s*(?:false|undefined)/,
    'wrapper must clear verifying flag in finally block')
})

test('runEklavyaAgent wrapper RE-ASSERTS verifying via setInterval (sticky-flag fix)', () => {
  // CRITICAL: persistCheckpointNow's _checkpointPending gets CLEARED after each
  // flush, so `verifying: true` only survives the first flush. Subsequent flushes
  // (e.g., Phase A3 heartbeat fires persistCheckpointNow() with no args) overwrite
  // the checkpoint without verifying. The wrapper must re-assert verifying:true
  // periodically (sub-5s interval, since 5s is the flush debounce ceiling).
  // Caught during round-2 live test 2026-05-09: daemon SIGKILL'd at exactly 5min
  // stale despite verifying=true being set once at wrapper entry.
  const wrapperStart = SRC.indexOf('async function runEklavyaAgent(target, taskId) {')
  const wrapperBody = SRC.slice(wrapperStart, wrapperStart + 2000)
  assert.match(wrapperBody, /setInterval\s*\([\s\S]{0,200}?persistCheckpointNow\s*\(\s*\{\s*verifying\s*:\s*true\s*\}/,
    'wrapper must use setInterval to re-assert persistCheckpointNow({verifying:true})')
  assert.match(wrapperBody, /clearInterval/,
    'wrapper must clearInterval in finally to stop re-assertion')
  // Sanity: interval must be < 5000ms (the persistCheckpointNow flush ceiling)
  const intervalMatch = wrapperBody.match(/setInterval\s*\([\s\S]{0,200}?,\s*(\d+)\s*\)/)
  assert.ok(intervalMatch, 'setInterval must have an explicit interval value')
  const intervalMs = parseInt(intervalMatch[1])
  assert.ok(intervalMs > 0 && intervalMs < 5000,
    `re-assert interval must be < 5s flush ceiling (got ${intervalMs}ms)`)
})

test('runEklavyaAgent wrapper awaits the inner function', () => {
  const wrapperStart = SRC.indexOf('async function runEklavyaAgent(target, taskId) {')
  const wrapperBody = SRC.slice(wrapperStart, wrapperStart + 2000)
  assert.match(wrapperBody, /\bawait\s+_runEklavyaAgentInner\s*\(/,
    'wrapper must await _runEklavyaAgentInner(target, taskId)')
})

test('_runEklavyaAgentInner contains the actual recon logic', () => {
  const innerStart = SRC.indexOf('async function _runEklavyaAgentInner')
  assert.ok(innerStart > 0, '_runEklavyaAgentInner must exist')
  // Function body is ~365 lines / ~17KB. Use 25KB slice to safely cover Phase G3.
  const innerSlice = SRC.slice(innerStart, innerStart + 25000)
  // The inner function must contain Phase A1, A3, G3 markers (to confirm the
  // entire body actually got moved here, not left behind in the wrapper)
  assert.match(innerSlice, /Phase A1: katana fast crawl/, 'Phase A1 must be inside inner')
  assert.match(innerSlice, /Phase A3: crawl4ai browser crawl/, 'Phase A3 must be inside inner')
  assert.match(innerSlice, /Phase G3: probing discovered URLs/, 'Phase G3 must be inside inner')
})

test('Phase A3 still uses runWithHeartbeat (round-1 fix preserved)', () => {
  const innerStart = SRC.indexOf('async function _runEklavyaAgentInner')
  const innerSlice = SRC.slice(innerStart, innerStart + 12000)
  const phaseA3 = innerSlice.match(/Phase A3:[\s\S]{0,4000}?(?:\bPhase B\b|\bdiscovered\s*=\s*new Set)/)?.[0] || ''
  assert.match(phaseA3, /\bawait\s+runWithHeartbeat\b/,
    'Phase A3 must STILL use runWithHeartbeat (regression guard for round-1 fix)')
})
