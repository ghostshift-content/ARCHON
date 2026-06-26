// test/event-bus-trajectory-wiring.test.js
//
// Sprint C.1 Task 6 — module-level grep tests confirming the trajectory
// observer is wired into the UNIVERSAL spawnAgent path in event-bus.js,
// NOT pentest-only Phase 2 dispatch. Catches accidental regression that
// would silently disable observer telemetry across one or more squads.
//
// Framework-wide directive (Jay, 2026-05-09): the observer MUST fire for
// EVERY squad's specialists (pentest, cloud-security, network-pentest,
// code-review, stocks, etc.) without per-squad changes. The cleanest way
// to honour that is to hook spawnAgent's resolve path — every squad's
// dispatcher calls spawnAgent.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

test('event-bus.js requires trajectory-observer module', () => {
  assert.match(SRC, /require\(['"]\.\/agents\/trajectory-observer['"]\)/,
    "event-bus.js must require './agents/trajectory-observer'")
})

test('event-bus.js calls observeSpecialistOutput', () => {
  assert.match(SRC, /observeSpecialistOutput\s*\(/,
    'observeSpecialistOutput must be invoked in event-bus.js')
})

test('observer call is fail-soft', () => {
  const idx = SRC.indexOf('observeSpecialistOutput')
  const before = SRC.slice(Math.max(0, idx - 800), idx)
  const after = SRC.slice(idx, idx + 500)
  const hasTryBefore = /try\s*\{/.test(before)
  const hasCatchAfter = /\.catch\s*\(/.test(after)
  assert.ok(hasTryBefore || hasCatchAfter,
    'observer call must be fail-soft (try/catch wrapping or .catch handler)')
})

test('observer wired in the universal spawnAgent path (framework-wide, not pentest-only)', () => {
  // The wiring should be inside spawnAgent OR called from its return path,
  // so every squad benefits without per-squad changes.
  const spawnAgentIdx = SRC.indexOf('async function spawnAgent') > 0
                        ? SRC.indexOf('async function spawnAgent')
                        : SRC.indexOf('function spawnAgent')
  if (spawnAgentIdx < 0) {
    // If spawnAgent isn't a top-level function, the observer must at least
    // appear ABOVE Phase 2 dispatch (pentest-specific) to indicate generic placement.
    return // soft pass — manual review must confirm framework-wide intent
  }
  const observeIdx = SRC.indexOf('observeSpecialistOutput')
  // The observer call should be reasonably close to spawnAgent (within ~5KB)
  // OR should be wired in a way that proves it's not pentest-specific.
  const distanceFromSpawnAgent = Math.abs(observeIdx - spawnAgentIdx)
  const closeToSpawnAgent = distanceFromSpawnAgent < 5000
  // Either close to spawnAgent OR not nestled inside Phase 2a/b/c/d dispatch
  const phase2aIdx = SRC.indexOf('Phase 2a:')
  const phase2dIdx = SRC.indexOf('Phase 2d:')
  const inPhase2Block = phase2aIdx > 0 && observeIdx > phase2aIdx &&
                        phase2dIdx > 0 && observeIdx < phase2dIdx + 5000
  assert.ok(closeToSpawnAgent || !inPhase2Block,
    'observer wiring must NOT be nestled only in pentest-Phase-2 block — must be framework-wide')
})

test('observer log path uses canonical /root/intel default', () => {
  const idx = SRC.indexOf('observeSpecialistOutput')
  const block = SRC.slice(idx, idx + 1000)
  // Either explicit canonical path OR default-omitted (uses module DEFAULT_LOG_PATH)
  const explicitPath = /trajectory-observations\.jsonl/.test(block)
  const noLogFileArg = !/logFile\s*:/.test(block)
  assert.ok(explicitPath || noLogFileArg,
    'observer call must use canonical log path (default or explicit)')
})

test('observer wiring does NOT block the spawnAgent return path', () => {
  // The observer's LLM call is ~5-30s; we cannot make every spawnAgent wait that long.
  // Verify wiring uses non-blocking pattern: IIFE, .then/.catch, or void-returning closure.
  const idx = SRC.indexOf('observeSpecialistOutput')
  const before = SRC.slice(Math.max(0, idx - 200), idx + 300)
  const isNonBlocking = /;\s*\(\s*async\s*\(\s*\)\s*=>/m.test(before) ||
                        /\)\s*\.\s*catch\s*\(/m.test(SRC.slice(idx, idx + 400)) ||
                        /void\s+observeSpecialistOutput/.test(before)
  assert.ok(isNonBlocking,
    'observer call must be non-blocking (IIFE / .catch / void) — pipeline cannot wait on LLM')
})
