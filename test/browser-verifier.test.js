const assert = require('node:assert')
const { test } = require('node:test')
const path = require('node:path')
const { verifyRecipe, verifyAll } = require('../agents/browser-verifier')

const FIXTURE = (name) => `file://${path.resolve(__dirname, 'fixtures/browser-validator', name)}`

// Tests below load fixtures via file:// URLs. The validator default-denies
// file:// URLs (production safety); tests must opt in via { allowFileUrls:
// true }. Production callers (Phase 3.8 dispatcher in event-bus.js) leave
// this at its default false.
const FIXTURE_OPTS = { allowFileUrls: true }

test('dom-xss fires on vulnerable sink', { timeout: 60000 }, async () => {
  const recipe = {
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'unsafe HTML write from location.hash',
    steps: [
      { action: 'navigate', url: FIXTURE('dom-xss-fires.html') + '#%3Cimg%20src=x%20onerror=window.__xss_fired__=true%3E' },
      { action: 'wait_for', timeout_ms: 1000 },
      { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  }
  const r = await verifyRecipe(recipe, FIXTURE_OPTS)
  assert.strictEqual(r.executed, true)
  assert.strictEqual(r.browser_fired, true)
  assert.strictEqual(r.verdict, 'CONFIRMED')
})

test('dom-xss does NOT fire on safe textContent sink', { timeout: 60000 }, async () => {
  const recipe = {
    finding_id: 'F2', finding_type: 'dom-xss',
    description: 'textContent sink — should not execute',
    steps: [
      { action: 'navigate', url: FIXTURE('dom-xss-blocked.html') + '#%3Cimg%20src=x%20onerror=window.__xss_fired__=true%3E' },
      { action: 'wait_for', timeout_ms: 1000 },
      { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  }
  const r = await verifyRecipe(recipe, FIXTURE_OPTS)
  assert.strictEqual(r.browser_fired, false)
  assert.strictEqual(r.verdict, 'KILLED')
})

test('proto-pollution propagates to plain objects', { timeout: 60000 }, async () => {
  // IMPORTANT: must use a LITERAL JSON string here, not JSON.stringify().
  // JSON.stringify({__proto__:{polluted:'yes'}}) produces "{}" because in object-literal
  // syntax, __proto__: sets the prototype (not an own property), so JSON.stringify
  // sees no enumerable own keys. To actually test prototype pollution, the JSON text
  // must contain a __proto__ key as a regular JSON property name.
  const payload = encodeURIComponent('{"__proto__":{"polluted":"yes"}}')
  const recipe = {
    finding_id: 'F3', finding_type: 'prototype-pollution',
    description: 'unsafe merge via __proto__',
    steps: [
      { action: 'navigate', url: FIXTURE('proto-pollution.html') + `?payload=${payload}` },
      { action: 'wait_for', timeout_ms: 500 },
      { action: 'evaluate', expression: '({}).polluted === "yes"' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  }
  const r = await verifyRecipe(recipe, FIXTURE_OPTS)
  assert.strictEqual(r.browser_fired, true)
})

test('rejects invalid recipe before launching browser', async () => {
  const r = await verifyRecipe({ finding_id: 'F5', finding_type: '', steps: [] })
  assert.strictEqual(r.executed, false)
  assert.strictEqual(r.verdict, 'INDETERMINATE')
  assert.match(r.reason, /finding_type/)
})

test('verifyRecipe forwards allowedFindingTypes to validator (strict mode)', async () => {
  // Recipe finding_type 'sqli' is NOT in the caller's allowlist.
  // Validator must reject before launching browser; result is INDETERMINATE.
  const recipe = {
    finding_id: 'F-strict-1', finding_type: 'sqli',
    description: 'sql-injection — should be rejected by browser-side allowlist',
    steps: [{ action: 'navigate', url: 'http://localhost/' }]
  }
  const r = await verifyRecipe(recipe, {
    allowedFindingTypes: new Set(['dom-xss']),
  })
  assert.strictEqual(r.executed, false, 'browser must not launch when type rejected')
  assert.strictEqual(r.verdict, 'INDETERMINATE')
  assert.match(r.reason, /allowlist|finding_type/i)
})

test('verifyAll returns array matching input length', { timeout: 60000 }, async () => {
  const recipes = [
    { finding_id: 'A', finding_type: 'dom-xss', description: 'x',
      steps: [{ action: 'navigate', url: FIXTURE('dom-xss-fires.html') }] },
    { finding_id: 'B', finding_type: 'invalid-type',
      description: 'x', steps: [] }
  ]
  const results = await verifyAll(recipes, FIXTURE_OPTS)
  assert.strictEqual(results.length, 2)
  assert.strictEqual(results[0].finding_id, 'A')
  assert.strictEqual(results[1].finding_id, 'B')
})
