'use strict'
// Focus enforcement: a focused scan must run ONLY the selected classes' specialists.
//   - focusedSpecialists() filters the roster to the focus set (null = full scan).
//   - focusAllows() gates the surface-triggered conditional dispatches (SPECTRE/DECOY/RANGER-CMDi)
//     so "test XSS only" never spawns an out-of-focus specialist — while a full scan is unchanged.
const { test } = require('node:test')
const assert = require('node:assert')
const {
  focusedSpecialists, focusAllows, specialistForClass,
  focusAllowsFinding, focusDirective,
} = require('../src/pipeline/focus-map')

// mirrors the live pentest roster order (FALLBACK_PENTEST_SPECIALISTS + conditional specialists)
const ROSTER = ['viper', 'drill', 'relay', 'vault', 'warden', 'forge', 'ledger', 'sentry', 'gateway', 'keyring', 'spectre', 'decoy']

test('focusedSpecialists filters the roster to the selected classes (roster order)', () => {
  assert.deepStrictEqual(focusedSpecialists(['xss', 'access-control', 'sqli'], ROSTER), ['viper', 'drill', 'warden'])
  assert.deepStrictEqual(focusedSpecialists(['xss'], ROSTER), ['viper'])
  assert.deepStrictEqual(focusedSpecialists(['xxe', 'csrf'], ROSTER), ['spectre', 'decoy'])
})

test('no focus runs full roster; unknown focus fails closed', () => {
  assert.strictEqual(focusedSpecialists(null, ROSTER), null)
  assert.strictEqual(focusedSpecialists([], ROSTER), null)
  assert.deepStrictEqual(focusedSpecialists(['not-a-class'], ROSTER), [])
})

test('focusAllows: full scan (null) allows every specialist', () => {
  for (const a of ['spectre', 'decoy', 'ranger', 'viper', 'sentry']) {
    assert.strictEqual(focusAllows(null, a), true)
  }
})

test('focusAllows: the reported bug — xss/access-control/sqli focus blocks SPECTRE/DECOY/RANGER-CMDi', () => {
  const focus = focusedSpecialists(['xss', 'access-control', 'sqli'], ROSTER)  // ['viper','drill','warden']
  assert.strictEqual(focusAllows(focus, 'spectre'), false)  // XXE — was leaking
  assert.strictEqual(focusAllows(focus, 'decoy'), false)    // CSRF — was leaking
  assert.strictEqual(focusAllows(focus, 'ranger'), false)   // CMDi — was leaking
  assert.strictEqual(focusAllows(focus, 'sentry'), false)   // early-exit SENTRY — out of focus
  // in-focus specialists still allowed
  assert.strictEqual(focusAllows(focus, 'viper'), true)
  assert.strictEqual(focusAllows(focus, 'drill'), true)
  assert.strictEqual(focusAllows(focus, 'warden'), true)
})

test('focusAllows: an in-focus conditional still fires (e.g. XXE selected)', () => {
  const focus = focusedSpecialists(['xxe'], ROSTER)          // ['spectre']
  assert.strictEqual(focusAllows(focus, 'spectre'), true)
  assert.strictEqual(focusAllows(focus, 'decoy'), false)
})

test('specialistForClass maps a class to its primary specialist (for the UI test-plan)', () => {
  assert.strictEqual(specialistForClass('xss'), 'viper')
  assert.strictEqual(specialistForClass('sqli'), 'drill')
  assert.strictEqual(specialistForClass('access-control'), 'warden')
  assert.strictEqual(specialistForClass('xxe'), 'spectre')
  assert.strictEqual(specialistForClass('nonsense'), null)
})

test('XSS + access-control output gate admits only selected-class findings', () => {
  const focus = ['xss', 'access-control']
  assert.equal(focusAllowsFinding(focus, { agent: 'VIPER', cwe: 'CWE-79', details: 'Stored XSS in profile' }), true)
  assert.equal(focusAllowsFinding(focus, { agent: 'WARDEN', cwe: 'CWE-639', details: 'IDOR reads another account' }), true)
  assert.equal(focusAllowsFinding(focus, { agent: 'WARDEN', cwe: 'CWE-862', details: 'Missing authorization on admin action' }), true)
  assert.equal(focusAllowsFinding(focus, { agent: 'DRILL', cwe: 'CWE-89', details: 'SQL injection in q' }), false)
  assert.equal(focusAllowsFinding(focus, { agent: 'SCOUT', details: 'TLS header weakness' }), false)
})

test('source-review focus families retain their expected subtypes', () => {
  assert.equal(focusAllowsFinding(['access-control'], { vulnerability_class: 'idor' }), true)
  assert.equal(focusAllowsFinding(['authentication-session'], { vulnerability_class: 'auth', title: 'Authentication bypass' }), true)
  assert.equal(focusAllowsFinding(['api-security'], { vulnerability_class: 'graphql' }), true)
  assert.equal(focusAllowsFinding(['xss'], { vulnerability_class: 'sqli' }), false)
})

test('focused worker directive is explicit and absent for a full scan', () => {
  assert.equal(focusDirective([], ''), '')
  const directive = focusDirective(['xss', 'access-control'], '')
  assert.match(directive, /ONLY the selected vulnerability objectives/)
  assert.match(directive, /xss, access-control/)
  assert.match(directive, /do not actively test, pursue, emit, validate, or report unrelated/i)
})
