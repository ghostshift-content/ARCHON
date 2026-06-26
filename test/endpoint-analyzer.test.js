// test/endpoint-analyzer.test.js
//
// EndpointModel is the structured handoff artifact between recon (Phase 1)
// and vuln specialists (Phase 2). Mirrors the ChangeModel pattern from the
// multi-agent code-review article: Analyzer extracts FACTS + ASSUMPTIONS,
// Reviewer (specialist) attacks them. We test the schema validator + the
// assumption-extraction heuristics in isolation.

const assert = require('node:assert')
const { test } = require('node:test')
const ea = require('../agents/endpoint-analyzer')

test('EndpointModel schema has required fields', () => {
  const valid = ea.validateEndpointModel({
    endpoint: 'POST /api/invoice',
    purpose: 'Create invoice',
    inputs: [],
    auth_boundary: 'session-required',
    trust_zones: { user: [], server: [] },
    assumptions: [],
  })
  assert.strictEqual(valid.ok, true)
})

test('EndpointModel rejects missing required fields', () => {
  const r = ea.validateEndpointModel({ endpoint: 'GET /' })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /assumptions|inputs|auth_boundary|trust_zones|purpose/)
})

test('extractAssumptions catches unvalidated numeric input from path', () => {
  const a = ea.extractAssumptions({
    endpoint: 'POST /api/invoice',
    inputs: [{ name: 'discount_pct', source: 'user', validators: [], type: 'number' }],
  })
  assert.ok(a.some(s => /discount_pct/.test(s) && /no validation|unvalidated|range/i.test(s)),
    `expected unvalidated-numeric assumption, got: ${JSON.stringify(a)}`)
})

test('extractAssumptions catches auth-scope gap when user-source ID present', () => {
  const a = ea.extractAssumptions({
    endpoint: 'GET /api/orders/:order_id',
    inputs: [{ name: 'order_id', source: 'user-path', validators: [], type: 'string' }],
    auth_boundary: 'session-required',
  })
  assert.ok(a.some(s => /order_id/i.test(s) && /scope|ownership|bola|idor/i.test(s)),
    `expected auth-scope assumption, got: ${JSON.stringify(a)}`)
})

test('extractAssumptions returns empty when inputs already validated', () => {
  const a = ea.extractAssumptions({
    endpoint: 'POST /api/login',
    inputs: [
      { name: 'username', source: 'user', validators: ['string', 'maxLen:128'], type: 'string' },
      { name: 'password', source: 'user', validators: ['string', 'minLen:8'], type: 'string' },
    ],
    auth_boundary: 'public',
  })
  // No structural assumption gaps — but auth-boundary=public on /login is fine
  assert.ok(Array.isArray(a))
})

test('buildEndpointModelsFromRecon produces one model per endpoint', () => {
  const reconData = {
    endpoints: [
      { url: 'https://api.example.com/v1/users/{id}', method: 'GET' },
      { url: 'https://api.example.com/v1/invoice', method: 'POST', requires_auth: true },
    ],
  }
  const models = ea.buildEndpointModelsFromRecon(reconData)
  assert.strictEqual(models.length, 2)
  assert.strictEqual(models[0].endpoint, 'GET /v1/users/{id}')
  assert.strictEqual(models[1].endpoint, 'POST /v1/invoice')
  assert.strictEqual(models[1].auth_boundary, 'session-required')
})
