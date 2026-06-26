// test/scope-validator.test.js
//
// Validates each finding's host against the dispatch-time scope list.
// Three outcomes:
//   in-scope                 — host matches scope list (exact or wildcard)
//   out-of-scope             — host doesn't match, and no in-scope asset
//                              depends on it
//   infrastructure-dependency — host doesn't match scope, but an in-scope
//                              asset clearly depends on it (e.g. its
//                              checkout flow uses this payment backend)

const assert = require('node:assert')
const { test } = require('node:test')
const sv = require('../agents/scope-validator')

const SCOPE = Object.freeze({
  in_scope: [
    'www.lenovo.com',
    'account.lenovo.com',
    'www.motorola.com',
    '*.support.motorola.com',
  ],
  // Infrastructure-dependency: hosts NOT in scope but the listed dependents
  // ARE in scope and demonstrably depend on the host.
  infra_dependencies: {
    'paymentuxe-prod.cloud.motorola.net': ['www.motorola.com'],
    'paymentuxe-uat.dev.cloud.motorola.net': ['www.motorola.com'],
  },
})

function findingFor(url) {
  return { id: 'F-X', url, affected_url: url }
}

test('exact host match → in-scope', () => {
  const r = sv.validateFindingScope(findingFor('https://www.motorola.com/order/history'), SCOPE)
  assert.strictEqual(r.status, 'in-scope')
  assert.match(r.reason, /exact match/i)
})

test('wildcard subdomain match → in-scope', () => {
  const r = sv.validateFindingScope(findingFor('https://help.support.motorola.com/api'), SCOPE)
  assert.strictEqual(r.status, 'in-scope')
  assert.match(r.reason, /wildcard/i)
})

test('host with explicit infra dependency → infrastructure-dependency', () => {
  const r = sv.validateFindingScope(
    findingFor('https://paymentuxe-uat.dev.cloud.motorola.net/management/configprops'),
    SCOPE,
  )
  assert.strictEqual(r.status, 'infrastructure-dependency')
  assert.match(r.reason, /www\.motorola\.com/)
})

test('unknown host with no in-scope dependent → out-of-scope', () => {
  const r = sv.validateFindingScope(findingFor('https://random-evil.com/foo'), SCOPE)
  assert.strictEqual(r.status, 'out-of-scope')
})

test('missing URL → out-of-scope (fail-safe)', () => {
  const r = sv.validateFindingScope({ id: 'F-Y' }, SCOPE)
  assert.strictEqual(r.status, 'out-of-scope')
  assert.match(r.reason, /no url/i)
})

test('empty scope → all findings out-of-scope', () => {
  const r = sv.validateFindingScope(findingFor('https://www.motorola.com/x'), { in_scope: [], infra_dependencies: {} })
  assert.strictEqual(r.status, 'out-of-scope')
})

test('annotateFindings adds scope_status to every finding', () => {
  const findings = [
    { id: 'F-1', url: 'https://www.motorola.com/x' },
    { id: 'F-2', url: 'https://paymentuxe-prod.cloud.motorola.net/payment' },
    { id: 'F-3', url: 'https://random-evil.com/x' },
  ]
  const annotated = sv.annotateFindings(findings, SCOPE)
  assert.strictEqual(annotated[0].scope_status, 'in-scope')
  assert.strictEqual(annotated[1].scope_status, 'infrastructure-dependency')
  assert.strictEqual(annotated[2].scope_status, 'out-of-scope')
})

test('annotateFindings preserves all original fields', () => {
  const findings = [{ id: 'F-1', url: 'https://www.motorola.com/x', severity: 'high', custom: 'value' }]
  const r = sv.annotateFindings(findings, SCOPE)
  assert.strictEqual(r[0].severity, 'high')
  assert.strictEqual(r[0].custom, 'value')
  assert.ok(r[0].scope_status)
  assert.ok(r[0].scope_reason)
})

test('exports SCOPE_STATUS constants', () => {
  assert.ok(typeof sv.SCOPE_STATUS === 'object')
  assert.ok(sv.SCOPE_STATUS.IN_SCOPE)
  assert.ok(sv.SCOPE_STATUS.OUT_OF_SCOPE)
  assert.ok(sv.SCOPE_STATUS.INFRA_DEPENDENCY)
})

test('validateFindingScope: extracts URL from details when top-level missing', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: [],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-001',
    title: 'Test',
    details: 'Verified via curl -sI https://api.example.com/login',
    notes: ''
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'in-scope')
})

test('validateFindingScope: extracts URL from notes when details lacks one', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: [],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-002',
    title: 'Test',
    details: 'No URL in here, just narrative.',
    notes: 'Reproduced at https://www.example.com/path'
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'in-scope')
})

test('validateFindingScope: top-level url still wins over details URL', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: ['*.other.com'],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-003',
    title: 'Test',
    url: 'https://api.example.com/x',
    details: 'Also tested https://api.other.com/y'
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'in-scope')
})

test('validateFindingScope: still fails safe when no URL anywhere', () => {
  const SCOPE = {
    in_scope: ['*.example.com'],
    out_of_scope: [],
    infra_dependencies: {}
  }
  const finding = {
    id: 'F-004',
    title: 'Test',
    details: 'Nothing actionable here',
    notes: ''
  }
  const r = sv.validateFindingScope(finding, SCOPE)
  assert.strictEqual(r.status, 'out-of-scope')
  assert.match(r.reason, /no URL on finding/)
})
