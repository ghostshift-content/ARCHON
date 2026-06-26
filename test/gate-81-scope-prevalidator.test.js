// test/gate-81-scope-prevalidator.test.js
//
// GATE-81: Verifies event-bus.js wires the Phase 0.0 scope pre-validator
// at the universal entry point dispatchToAgent. Must run BEFORE Phase 0.5
// WAF detect (so blocked dispatches never reach any specialist).

'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const EB_PATH = path.join(__dirname, '..', 'event-bus.js')
const eb = fs.readFileSync(EB_PATH, 'utf8')

test('GATE-81: event-bus.js wires Phase 0.0 scope pre-validator', () => {
  assert.match(eb, /Phase 0\.0/, 'Phase 0.0 marker missing')
  assert.match(eb, /require\(['"]\.\/agents\/scope-prevalidator['"]\)/, 'scope-prevalidator require missing')
  assert.match(eb, /validateDispatch\(/, 'validateDispatch call missing')
})

test('GATE-81: blocked dispatches do NOT proceed to Phase 0.5 WAF detect', () => {
  const idx00 = eb.indexOf('Phase 0.0')
  // Use lastIndexOf: Phase 0.5 appears in TRACER function definitions earlier in the file;
  // the relevant Phase 0.5 (pentest pipeline — surface discovery + WAF context) is the LAST
  // occurrence, which lives inside the pentest dispatch path after our insertion point.
  const idx05 = eb.lastIndexOf('Phase 0.5')
  assert.ok(idx00 > -1 && idx05 > -1, 'both Phase 0.0 and 0.5 must exist')
  assert.ok(idx00 < idx05, `Phase 0.0 must come before Phase 0.5 (idx00=${idx00}, idx05=${idx05})`)
})

test('GATE-81: scope-prevalidator checks for blocked status and aborts', () => {
  const idx = eb.indexOf('Phase 0.0')
  assert.ok(idx > -1, 'Phase 0.0 marker not found')
  const slice = eb.slice(idx, idx + 3000)
  assert.match(slice, /['"]blocked['"]/, 'must check for blocked status string')
  assert.match(slice, /try\s*\{/, 'Phase 0.0 must be wrapped in try/catch (fail-soft)')
  assert.match(slice, /catch\s*\(/, 'Phase 0.0 must have catch block')
})
