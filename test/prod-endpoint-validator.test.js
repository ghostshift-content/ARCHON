// test/prod-endpoint-validator.test.js
//
// Validates that findings claiming PROD impact actually validated against
// production endpoints (not sandbox/test/uat). Q#8 (2026-05-15) shipped
// "F-002 PROD PayPal CRITICAL" where KRIPA validated against
// api.sandbox.paypal.com — confirmed false-positive once Jay tested PROD
// (invalid_client). This validator catches that mismatch programmatically.

const assert = require('node:assert')
const { test } = require('node:test')
const pev = require('../agents/prod-endpoint-validator')

test('production hostname → production', () => {
  const r = pev.classifyEndpoint('https://api.paypal.com/v1/oauth2/token')
  assert.strictEqual(r.kind, 'production')
})

test('sandbox PayPal → sandbox', () => {
  const r = pev.classifyEndpoint('https://api.sandbox.paypal.com/v1/oauth2/token')
  assert.strictEqual(r.kind, 'sandbox')
  assert.match(r.signal, /sandbox/i)
})

test('UAT subdomain → uat', () => {
  const r = pev.classifyEndpoint('https://paymentuxe-uat.dev.cloud.motorola.net/management/configprops')
  assert.strictEqual(r.kind, 'uat')
  assert.match(r.signal, /uat/i)
})

test('dev subdomain → dev', () => {
  const r = pev.classifyEndpoint('https://galvin-dev.motorola.com/auth')
  assert.strictEqual(r.kind, 'dev')
})

test('staging hostname → staging', () => {
  for (const u of [
    'https://staging.example.com',
    'https://stage-api.example.com',
    'https://api-staging.example.com',
  ]) {
    const r = pev.classifyEndpoint(u)
    assert.strictEqual(r.kind, 'staging', `expected staging for ${u}, got ${r.kind}`)
  }
})

test('test hostname → test', () => {
  const r = pev.classifyEndpoint('https://test-api.example.com')
  assert.strictEqual(r.kind, 'test')
})

test('path-based sandbox detection', () => {
  const r = pev.classifyEndpoint('https://api.example.com/sandbox/v1/oauth')
  assert.strictEqual(r.kind, 'sandbox')
  assert.match(r.signal, /path/i)
})

test('unknown host → production by default (only flag explicit signals)', () => {
  // Conservative default: don't flag unless explicit non-prod signal present.
  // Reason: an attacker submitting a real bug shouldn't get blocked by
  // overzealous classifier.
  const r = pev.classifyEndpoint('https://api.unknown-service.com/v1/oauth')
  assert.strictEqual(r.kind, 'production')
})

test('auditFindings flags PROD-claim against sandbox validation', () => {
  const findings = [
    {
      id: 'F-001', severity: 'Critical',
      title: 'PROD PayPal credentials valid',
      url: 'https://api.sandbox.paypal.com/v1/oauth2/token',
      details: 'Successfully obtained access token from PROD PayPal',
    },
  ]
  const audited = pev.auditFindings(findings)
  assert.strictEqual(audited[0].prod_validation_warning, true)
  assert.match(audited[0].prod_validation_reason, /sandbox/i)
  assert.match(audited[0].prod_validation_reason, /title claims PROD/i)
})

test('auditFindings does NOT flag matching prod claim + prod endpoint', () => {
  const findings = [{
    id: 'F-002', severity: 'High',
    title: 'PROD API exposes credentials',
    url: 'https://api.example.com/admin/secrets',
  }]
  const audited = pev.auditFindings(findings)
  assert.strictEqual(audited[0].prod_validation_warning, false)
})

test('auditFindings does NOT flag low-severity findings (only Critical/High)', () => {
  const findings = [{
    id: 'F-003', severity: 'Low',
    title: 'PROD info disclosure',
    url: 'https://api.sandbox.example.com/info',
  }]
  const audited = pev.auditFindings(findings)
  // Low severity is informational regardless of endpoint kind
  assert.strictEqual(audited[0].prod_validation_warning, false)
})

test('auditFindings flags Critical even if title is generic (severity alone is enough)', () => {
  const findings = [{
    id: 'F-004', severity: 'Critical',
    title: 'Credential exposure',
    url: 'https://api.sandbox.paypal.com/v1/oauth2/token',
  }]
  const audited = pev.auditFindings(findings)
  // Critical severity + sandbox endpoint = warning, regardless of title
  assert.strictEqual(audited[0].prod_validation_warning, true)
})

test('summarize counts warnings correctly', () => {
  const findings = [
    { id: 'F-1', severity: 'Critical', url: 'https://api.sandbox.x.com', title: 'PROD x' },
    { id: 'F-2', severity: 'High', url: 'https://api.x.com', title: 'PROD x' },
    { id: 'F-3', severity: 'Critical', url: 'https://test.x.com', title: 'PROD x' },
  ]
  const audited = pev.auditFindings(findings)
  const s = pev.summarize(audited)
  assert.strictEqual(s.warnings, 2)
  assert.strictEqual(s.clean, 1)
})

test('exports ENDPOINT_KIND constants', () => {
  assert.ok(pev.ENDPOINT_KIND.PRODUCTION)
  assert.ok(pev.ENDPOINT_KIND.SANDBOX)
  assert.ok(pev.ENDPOINT_KIND.UAT)
  assert.ok(pev.ENDPOINT_KIND.STAGING)
})
