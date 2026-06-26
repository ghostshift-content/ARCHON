const assert = require('node:assert')
const { test } = require('node:test')
const { validateRecipe } = require('../agents/browser-recipe-validator')

test('rejects recipe with missing finding_id', () => {
  const r = validateRecipe({ steps: [] })
  assert.strictEqual(r.ok, false)
})

test('accepts any non-empty finding_type by default (permissive mode)', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'arbitrary-domain-type',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  })
  assert.strictEqual(r.ok, true)
})

test('rejects empty finding_type', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: '',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /finding_type/)
})

test('honors caller-provided allowedFindingTypes set', () => {
  const allowlist = new Set(['dom-xss', 'csp-bypass'])
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'sql-injection',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  }, { allowedFindingTypes: allowlist })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /allowlist/)
})

test('passes when type is in caller-provided allowlist', () => {
  const allowlist = new Set(['dom-xss', 'csp-bypass'])
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  }, { allowedFindingTypes: allowlist })
  assert.strictEqual(r.ok, true)
})

test('rejects step with non-whitelisted action', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x', steps: [{ action: 'shell', command: 'rm -rf /' }]
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /action/)
})

test('rejects evaluate with non-read-only expression', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x',
    steps: [
      { action: 'navigate', url: 'http://x' },
      { action: 'evaluate', expression: 'window.__pwned=true' }
    ]
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /evaluate|assignment/i)
})

test('accepts a valid dom-xss recipe', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'reflected payload via location.hash',
    steps: [
      { action: 'navigate', url: 'http://target/page' },
      { action: 'wait_for', timeout_ms: 2000 },
      { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  })
  assert.strictEqual(r.ok, true, r.reason)
})

test('rejects step with missing required field', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x',
    steps: [{ action: 'navigate' }]
  })
  assert.strictEqual(r.ok, false)
})

test('rejects too many steps (cap at 20)', () => {
  const steps = Array(25).fill({ action: 'navigate', url: 'http://x' })
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x', steps
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /step/)
})

// File-URL gate (Fix 3): default-deny file:// URLs in production.
// Tests with fixture URLs must opt in via { allowFileUrls: true }.

test('rejects file:// URL by default (production safety)', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x',
    steps: [{ action: 'navigate', url: 'file:///etc/passwd' }]
  })
  assert.strictEqual(r.ok, false, 'file:// must be rejected without opt-in')
  assert.match(r.reason, /url must be http\(s\)|file:\/\//i)
})

test('accepts file:// URL when { allowFileUrls: true } is passed', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'fixture-driven test recipe',
    steps: [{ action: 'navigate', url: 'file:///tmp/fixture.html' }]
  }, { allowFileUrls: true })
  assert.strictEqual(r.ok, true, r.reason)
})

test('still rejects non-http/file scheme even with allowFileUrls', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x',
    steps: [{ action: 'navigate', url: 'javascript:alert(1)' }]
  }, { allowFileUrls: true })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /url must be http/i)
})
