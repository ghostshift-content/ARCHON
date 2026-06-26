
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
const test = require('node:test')
const assert = require('node:assert')
const sp = require('../agents/severity-profile')

test('GATE-88: severity-profile exports resolveProfile', () => {
  assert.strictEqual(typeof sp.resolveProfile, 'function')
})

test('GATE-88: program_type=kudos → pentest', () => {
  assert.strictEqual(sp.resolveProfile({ program_type: 'kudos' }), 'pentest')
})

test('GATE-88: program_type=paid_bounty → bounty', () => {
  assert.strictEqual(sp.resolveProfile({ program_type: 'paid_bounty' }), 'bounty')
})

test('GATE-88: explicit severity_profile wins over program_type', () => {
  assert.strictEqual(
    sp.resolveProfile({ severity_profile: 'comprehensive', program_type: 'paid_bounty' }),
    'comprehensive'
  )
})

test('GATE-88: event-bus.js calls resolveProfile', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/event-bus.js'), 'utf8')
  assert.match(src, /resolveProfile\(/,
    'event-bus.js must call severityProfile.resolveProfile for profile selection')
})
