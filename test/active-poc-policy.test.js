// test/active-poc-policy.test.js
//
// Covers the active-poc-policy module — the safety contract for Phase 3.08
// active-PoC mode. Three layers: permission validation, scope-domain
// glob/exact matching, cap state tracking (per-finding + total), defender
// abort heuristics, env-gate kill-switch.

const assert = require('node:assert')
const { test } = require('node:test')
const policy = require('../agents/active-poc-policy')

test('rejects task without engagement_mode=active-poc', () => {
  const r = policy.validatePermission({})
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /engagement_mode/)
})

test('rejects task without active_poc_permission', () => {
  const r = policy.validatePermission({ engagement_mode: 'active-poc' })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /missing active_poc_permission/)
})

test('rejects expired permission', () => {
  const r = policy.validatePermission({
    engagement_mode: 'active-poc',
    active_poc_permission: {
      permission_id: 'p1', issued_by: 'jay',
      valid_until: '2020-01-01T00:00:00Z',
      scope_domains: ['example.com'], capabilities: ['x'],
      max_total_probes: 10, max_per_finding: 2,
    },
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /expired/)
})

test('targetInScope: glob and exact', () => {
  const perm = {
    permission_id: 'p', issued_by: 'jay', valid_until: '2099-01-01T00:00:00Z',
    scope_domains: ['*.lenovo.com', 'aws.amazon.com'],
    scope_excludes: ['billing.lenovo.com'],
    capabilities: ['x'], max_total_probes: 10, max_per_finding: 2,
  }
  assert.strictEqual(policy.targetInScope('webvpn.us.lenovo.com', perm), true)
  assert.strictEqual(policy.targetInScope('aws.amazon.com', perm), true)
  assert.strictEqual(policy.targetInScope('billing.lenovo.com', perm), false)
  assert.strictEqual(policy.targetInScope('evil.com', perm), false)
})

test('envIsEnabled returns false without env var', () => {
  delete process.env.archon_ACTIVE_POC
  assert.strictEqual(policy.envIsEnabled(), false)
  process.env.archon_ACTIVE_POC = 'enabled'
  assert.strictEqual(policy.envIsEnabled(), true)
  delete process.env.archon_ACTIVE_POC
})

test('shouldAbortOnDefender detects WAF, rate-limit, CAPTCHA', () => {
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 429 }), true)
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 403, headers: { 'cf-mitigated': 'challenge' } }), true)
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 200, body: 'g-recaptcha-response' }), true)
  assert.strictEqual(policy.shouldAbortOnDefender({ status: 200, body: '{}' }), false)
})

test('newCapState + canProbe + recordProbe enforce caps', () => {
  const state = policy.newCapState({ max_total_probes: 5, max_per_finding: 2 })
  assert.strictEqual(policy.canProbe(state, 'F-1'), true)
  policy.recordProbe(state, 'F-1')
  assert.strictEqual(policy.canProbe(state, 'F-1'), true)
  policy.recordProbe(state, 'F-1')
  assert.strictEqual(policy.canProbe(state, 'F-1'), false)
  assert.strictEqual(policy.canProbe(state, 'F-2'), true)
  for (let i = 0; i < 3; i++) policy.recordProbe(state, 'F-2')
  assert.strictEqual(policy.canProbe(state, 'F-3'), false)
})
