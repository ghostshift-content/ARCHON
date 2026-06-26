#!/usr/bin/env node
// Unit tests for /root/agents/target-classifier.js
// Run: node /root/agents/test/target-classifier.test.js
//
// Invariants under test:
//   - 'unknown' is returned when evidence is absent (never a wrong guess)
//   - user hints override detected values
//   - no restriction fields ever leak into the profile (allowed_specialists etc.)
//   - disclaimer is always present
//   - getPriorityOrderForSquad returns ordered list, not a filter set
//   - severity multiplier is a pure numeric weight (never zero, never negative)

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const tc = require('../src/routing/target-classifier')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

console.log('target-classifier tests:')

tc.resetCache()

test('all 6 DIMENSIONS exported and correct', () => {
  assert.deepStrictEqual(tc.DIMENSIONS.sort(),
    ['auth_model', 'domain', 'environment', 'hosting', 'surface_shape', 'tech_stack'].sort())
})

test('empty context → all dims unknown, disclaimer present', () => {
  const p = tc.classify({})
  for (const d of tc.DIMENSIONS) {
    assert.strictEqual(p[d], 'unknown', `${d} should be unknown on empty context, got ${p[d]}`)
    assert.strictEqual(p.sources[d], 'default')
    assert.strictEqual(p.confidence[d], 0)
  }
  assert.ok(p.disclaimer, 'disclaimer must be present')
  assert.match(p.disclaimer, /hint|hypothesis|scope fence/i)
})

test('azure-native detected from hostname', () => {
  const p = tc.classify({ hostname: 'myapp.azurewebsites.net', headers: {} })
  assert.strictEqual(p.hosting, 'azure-native')
  assert.strictEqual(p.sources.hosting, 'auto')
  assert.ok(p.confidence.hosting > 0.5)
})

test('cloudflare detected from header', () => {
  const p = tc.classify({ hostname: 'example.com', headers: { server: 'cloudflare', 'cf-ray': '123' } })
  assert.strictEqual(p.hosting, 'cloudflare')
})

test('ASP.NET detected from x-powered-by header', () => {
  const p = tc.classify({ headers: { 'x-powered-by': 'ASP.NET' } })
  assert.strictEqual(p.tech_stack, 'aspnet')
})

test('SPA detected from HTML markers + big bundle', () => {
  const p = tc.classify({
    bodySnippet: '<!DOCTYPE html><div id="root"></div>',
    jsBundles: [{ url: '/bundle.js', size_bytes: 400 * 1024 }],
  })
  assert.strictEqual(p.surface_shape, 'spa')
})

test('api-only detected when majority content-types are JSON', () => {
  const p = tc.classify({
    contentTypes: ['application/json', 'application/json', 'application/json', 'text/plain'],
  })
  assert.strictEqual(p.surface_shape, 'api-only')
})

test('SAML auth detected from redirect chain', () => {
  const p = tc.classify({ redirects: ['https://sso.corp.com/saml/login?SAMLRequest=abc'] })
  assert.strictEqual(p.auth_model, 'saml')
})

test('azure-ad auth detected from login.microsoftonline.com redirect', () => {
  const p = tc.classify({ redirects: ['https://login.microsoftonline.com/common/oauth2/authorize'] })
  assert.ok(['azure-ad', 'oauth-sso'].includes(p.auth_model),
    `expected azure-ad or oauth-sso, got ${p.auth_model}`)
})

test('environment: staging detected from hostname', () => {
  const p = tc.classify({ hostname: 'staging.example.com' })
  assert.strictEqual(p.environment, 'staging')
})

test('environment: prod detected when no staging/dev tokens', () => {
  const p = tc.classify({ hostname: 'www.example.com' })
  assert.strictEqual(p.environment, 'prod')
})

test('domain: fintech detected from hostname "bank"', () => {
  const p = tc.classify({ hostname: 'bank.example.com' })
  assert.strictEqual(p.domain, 'fintech')
})

test('user hints override auto-detection', () => {
  const p = tc.classify({
    hostname: 'staging.example.com', // would auto-detect as staging
    userHints: { environment: 'prod', domain: 'fintech' },
  })
  assert.strictEqual(p.environment, 'prod')
  assert.strictEqual(p.sources.environment, 'user')
  assert.strictEqual(p.confidence.environment, 1.0)
  assert.strictEqual(p.domain, 'fintech')
})

test('INVARIANT: profile never carries restriction fields', () => {
  const probes = [
    {},
    { hostname: 'api.stripe.com' },
    { hostname: 'bank.foo.com', userHints: { domain: 'fintech', environment: 'prod' } },
  ]
  for (const ctx of probes) {
    const p = tc.classify(ctx)
    assert.ok(!('allowed_specialists' in p), 'allowed_specialists must never appear')
    assert.ok(!('skip_specialists' in p), 'skip_specialists must never appear')
    assert.ok(!('exclude' in p), 'exclude must never appear')
    assert.ok(!('allow' in p), 'allow must never appear')
  }
})

test('getPriorityOrderForSquad returns array (not a filter)', () => {
  const profile = tc.classify({ userHints: { surface_shape: 'spa', auth_model: 'saml' } })
  const order = tc.getPriorityOrderForSquad('pentest', profile)
  assert.ok(Array.isArray(order), 'must return array')
  assert.ok(order.length > 0, 'should have priority list for pentest+spa+saml')
  // First few should include viper and scout (SPA priority) and/or vault (SAML)
  assert.ok(order.includes('viper') || order.includes('scout'),
    `expected viper/scout in priority, got: ${order.join(',')}`)
})

test('getPriorityOrderForSquad returns [] for unknown squad (no-op fallback)', () => {
  const profile = tc.classify({ userHints: { surface_shape: 'spa' } })
  const order = tc.getPriorityOrderForSquad('not-a-real-squad', profile)
  assert.deepStrictEqual(order, [])
})

test('getPriorityOrderForSquad returns [] when all dims unknown', () => {
  const profile = tc.classify({})
  const order = tc.getPriorityOrderForSquad('pentest', profile)
  assert.deepStrictEqual(order, [])
})

test('severity multiplier: always positive, bounded', () => {
  const sandboxProfile = tc.classify({ userHints: { environment: 'sandbox', domain: 'marketing' } })
  const mult = tc.getSeverityMultiplier(sandboxProfile)
  assert.ok(mult > 0, 'multiplier must be positive (never zeros a finding)')
  assert.ok(mult < 2, 'multiplier must be bounded < 2')
})

test('severity multiplier: fintech prod > marketing sandbox', () => {
  const prodFintech = tc.classify({ userHints: { environment: 'prod', domain: 'fintech' } })
  const sandboxMktg = tc.classify({ userHints: { environment: 'sandbox', domain: 'marketing' } })
  assert.ok(tc.getSeverityMultiplier(prodFintech) > tc.getSeverityMultiplier(sandboxMktg),
    'fintech/prod should weight higher than marketing/sandbox')
})

test('buildPromptFragment includes all 6 dimensions + disclaimer', () => {
  const p = tc.classify({ hostname: 'staging.bank.com', headers: { server: 'cloudflare' } })
  const frag = tc.buildPromptFragment(p)
  for (const d of tc.DIMENSIONS) {
    assert.ok(frag.includes(d), `fragment missing dimension '${d}'`)
  }
  assert.match(frag, /DISCLAIMER|hypothesis|scope fence|hint/i)
  assert.match(frag, /TARGET PROFILE/i)
})

test('buildPromptFragment returns empty string for null profile', () => {
  assert.strictEqual(tc.buildPromptFragment(null), '')
})

test('saveProfile + loadProfile round-trip', () => {
  const testTaskId = 'test-target-classifier-' + Date.now()
  const p = tc.classify({ hostname: 'example.com', taskId: testTaskId })
  const savedPath = tc.saveProfile(testTaskId, p)
  try {
    assert.ok(fs.existsSync(savedPath))
    const loaded = tc.loadProfile(testTaskId)
    assert.deepStrictEqual(loaded, p)
  } finally {
    try { fs.unlinkSync(savedPath) } catch {}
  }
})

test('loadProfile returns null for missing taskId', () => {
  const loaded = tc.loadProfile('nonexistent-' + Date.now())
  assert.strictEqual(loaded, null)
})

test('saveProfile rejects empty taskId', () => {
  assert.throws(() => tc.saveProfile('', { test: 'x' }), /taskId required/)
  assert.throws(() => tc.saveProfile(null, { test: 'x' }), /taskId required/)
})

test('disabled rules → unknown profile + disabled reason', () => {
  // Temporarily write disabled rules
  const origPath = tc.RULES_PATH
  const backup = origPath + '.bk-test'
  fs.copyFileSync(origPath, backup)
  try {
    const raw = JSON.parse(fs.readFileSync(origPath, 'utf-8'))
    raw.enabled = false
    fs.writeFileSync(origPath, JSON.stringify(raw))
    tc.resetCache()
    const p = tc.classify({ hostname: 'bank.com' })
    for (const d of tc.DIMENSIONS) assert.strictEqual(p[d], 'unknown')
    assert.strictEqual(p._disabled_reason, 'rules-disabled')
  } finally {
    fs.copyFileSync(backup, origPath)
    fs.unlinkSync(backup)
    tc.resetCache()
  }
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
