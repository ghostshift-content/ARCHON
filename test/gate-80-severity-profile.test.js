// test/gate-80-severity-profile.test.js
//
// GATE-80: Verifies event-bus.js wires the Phase 3.075 severity-profile
// filter correctly — module is required, filter is called, archived
// findings are persisted (DOWNGRADE-NOT-DROP discipline), wire is
// fail-soft with try/catch.

'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const EB_PATH = path.join(__dirname, '..', 'event-bus.js')
const eb = fs.readFileSync(EB_PATH, 'utf8')

test('GATE-80: event-bus.js wires Phase 3.075 severity filter', () => {
  assert.match(eb, /Phase 3\.075/, 'Phase 3.075 marker missing')
  assert.match(eb, /require\(['"]\.\/agents\/severity-profile['"]\)/, 'severity-profile require missing')
  assert.match(eb, /agents\/squad-policy\//, 'squad-policy require missing')
  assert.match(eb, /filterFindings\(/, 'filterFindings call missing')
})

test('GATE-80: archived findings persisted to ARCHIVED-FINDINGS file (DOWNGRADE-NOT-DROP)', () => {
  assert.match(eb, /ARCHIVED-FINDINGS-/, 'ARCHIVED-FINDINGS-{taskId} path missing — archived findings would be silently dropped')
})

test('GATE-80: severity filter is fail-soft (logs + continues on error)', () => {
  const idx = eb.indexOf('Phase 3.075')
  assert.ok(idx > -1, 'Phase 3.075 marker not found')
  const slice = eb.slice(idx, idx + 3000)
  assert.match(slice, /try\s*\{/, 'Phase 3.075 must be wrapped in try/catch (fail-soft)')
  assert.match(slice, /catch\s*\(/, 'Phase 3.075 must have catch block')
})
