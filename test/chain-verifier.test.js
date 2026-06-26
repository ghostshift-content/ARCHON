#!/usr/bin/env node
// Unit tests for /root/agents/chain-verifier.js
// Run: node /root/agents/test/chain-verifier.test.js
// Exit 0 = all pass. Non-zero = regression.
//
// These tests are OFFLINE — use curl against a local file:// or dry-run where possible.
// One test does hit example.com to verify live behavior.

const assert = require('assert')
const cv = require('../src/pipeline/chain-verifier')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      throw new Error('async tests not supported in this file')
    }
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

console.log('chain-verifier tests:')

test('exports CHAIN_OUTPUT_SCHEMA', () => {
  assert.ok(cv.CHAIN_OUTPUT_SCHEMA)
  assert.strictEqual(cv.CHAIN_OUTPUT_SCHEMA.type, 'object')
  assert.ok(cv.CHAIN_OUTPUT_SCHEMA.required.includes('chains'))
})

// Sprint B Task B3.5: companion to the SCRIBE chain-orphan guard.
// Constructor must populate finding_ids with the IDs of the underlying
// confirmed findings being chained. Without this, the guard drops every
// chain because there is nothing to cross-check against VALIDATED-FINDINGS.
test('CHAIN_OUTPUT_SCHEMA includes finding_ids as required field per chain', () => {
  const schema = cv.CHAIN_OUTPUT_SCHEMA
  assert.ok(schema, 'CHAIN_OUTPUT_SCHEMA must be exported')
  const chainItemSchema =
    (schema.properties && schema.properties.chains && schema.properties.chains.items) ||
    schema.items ||
    null
  assert.ok(chainItemSchema, 'schema must define per-chain item shape')
  assert.ok(chainItemSchema.properties, 'chain item must define properties')
  assert.ok(
    chainItemSchema.properties.finding_ids,
    'finding_ids property missing from chain item schema',
  )
  assert.strictEqual(chainItemSchema.properties.finding_ids.type, 'array',
    'finding_ids must be typed as array')
  assert.ok(Array.isArray(chainItemSchema.required),
    'chain item must declare required[]')
  assert.ok(
    chainItemSchema.required.includes('finding_ids'),
    `finding_ids must be in required list, got: ${JSON.stringify(chainItemSchema.required)}`,
  )
})

test('empty chain fails', () => {
  const r = cv.verifyChain({ id: 'e', name: 'e', severity: 'Low', steps: [] })
  assert.strictEqual(r.verified, false)
  assert.match(r.reason, /no steps/)
})

test('dry-run skips execution', () => {
  const r = cv.verifyChain({
    id: 't', name: 't', severity: 'Info',
    steps: [{ step_id: 1, description: 'x', curl: 'curl https://example.com', expected_result: 'anything' }],
  }, { dryRun: true })
  assert.strictEqual(r.stepResults[0].status, 'dry-run')
})

test('rejects command not in allow-list (e.g. wget)', () => {
  // 2026-05-12: Allow-list expanded to curl/openssl/dig/nslookup/host for
  // multi-tool recon chains (Sprint May-12). wget is still rejected because
  // it has download side-effects we don't want unattended.
  const r = cv.verifyChain({
    id: 't', name: 't', severity: 'Low',
    steps: [{ step_id: 1, description: 'x', curl: 'wget https://example.com', expected_result: 'x' }],
  })
  assert.strictEqual(r.verified, false)
  assert.match(r.stepResults[0].reason, /first token must be one of curl\/openssl\/dig\/nslookup\/host/)
})

test('accepts openssl/dig/nslookup/host for recon steps (Sprint May-12)', () => {
  // Parser should accept these binaries. We use dryRun so we don't actually
  // shell-out — the test just verifies the parser doesn't reject the first token.
  for (const binary of ['openssl', 'dig', 'nslookup', 'host']) {
    const r = cv.verifyChain({
      id: 't', name: 't', severity: 'Low',
      steps: [{ step_id: 1, description: 'x', curl: `${binary} --help`, expected_result: 'x' }],
    }, { dryRun: true })
    assert.notStrictEqual(r.stepResults[0].status, 'rejected',
      `binary ${binary} unexpectedly rejected: ${r.stepResults[0].reason}`)
  }
})

test('rejects shell metacharacter injection (semicolon)', () => {
  const r = cv.verifyChain({
    id: 't', name: 't', severity: 'Critical',
    steps: [{ step_id: 1, description: 'evil', curl: 'curl https://example.com; rm -rf /', expected_result: 'x' }],
  })
  assert.strictEqual(r.verified, false)
  assert.match(r.stepResults[0].reason, /shell metacharacters/)
})

test('rejects backtick command substitution', () => {
  const r = cv.verifyChain({
    id: 't', name: 't', severity: 'Critical',
    steps: [{ step_id: 1, description: 'evil', curl: 'curl https://`whoami`.com', expected_result: 'x' }],
  })
  assert.strictEqual(r.verified, false)
  assert.match(r.stepResults[0].reason, /shell metacharacters|substitution/)
})

test('rejects $(...) command substitution', () => {
  const r = cv.verifyChain({
    id: 't', name: 't', severity: 'Critical',
    steps: [{ step_id: 1, description: 'evil', curl: 'curl https://$(whoami).com', expected_result: 'x' }],
  })
  assert.strictEqual(r.verified, false)
  assert.match(r.stepResults[0].reason, /command substitution/)
})

test('allows quoted strings containing special chars', () => {
  // Shell metacharacters inside quoted strings should NOT trigger rejection,
  // since we run without shell and the quote contents are a single argv token
  const r = cv.verifyChain({
    id: 't', name: 't', severity: 'Low',
    steps: [{ step_id: 1, description: 'quoted', curl: 'curl -d "name=a;b|c" -s https://example.com', expected_result: '' }],
  }, { dryRun: true })
  assert.strictEqual(r.stepResults[0].status, 'dry-run')
})

test('verifyChains returns summary', () => {
  const result = cv.verifyChains([
    { id: 'a', name: 'a', severity: 'Low', steps: [] },
    { id: 'b', name: 'b', severity: 'Low', steps: [] },
  ])
  assert.strictEqual(result.total, 2)
  assert.strictEqual(result.verified, 0)
})

// Live network test — uses example.com (stable, RFC 2606)
test('verifies a real chain end-to-end (example.com)', () => {
  const chain = {
    id: 'live-1', name: 'example reachability', severity: 'Info',
    steps: [
      { step_id: 1, description: 'root', curl: 'curl -s https://example.com', expected_result: '/Example Domain/i' },
      { step_id: 2, description: 'head', curl: 'curl -sI https://example.com', expected_result: 'HTTP 200' },
    ],
  }
  const r = cv.verifyChain(chain)
  assert.strictEqual(r.verified, true, `expected verified, got ${r.reason}`)
  assert.strictEqual(r.stepResults.length, 2)
  assert.ok(r.stepResults.every(s => s.matched))
})

test('fails chain when a step does not match', () => {
  const chain = {
    id: 'x', name: 'x', severity: 'Low',
    steps: [
      { step_id: 1, description: 'fetch', curl: 'curl -s https://example.com', expected_result: 'ThisStringWillNotAppear' },
    ],
  }
  const r = cv.verifyChain(chain)
  assert.strictEqual(r.verified, false)
  assert.strictEqual(r.stepResults[0].matched, false)
})

// (2026-04-23) Fix-#4 regression guards
test('HTTP 200 match works WITHOUT -i flag (fix for Apr-21 Run-1 0/3)', () => {
  // Plain `curl URL` — no -i, no -v. Previously this NEVER matched "HTTP 200"
  // because stdout contained only the body. Fix: verifier auto-injects
  // `-w "\nHTTP/STATUS/%{http_code}\n"` so status is always available.
  const chain = {
    id: 'status-fix', name: 's', severity: 'Low',
    steps: [{ step_id: 1, description: 'plain', curl: 'curl https://example.com', expected_result: 'HTTP 200' }],
  }
  const r = cv.verifyChain(chain)
  assert.strictEqual(r.verified, true, `expected verified, got ${r.reason}. response=${r.stepResults[0]?.response?.slice(0,80)}`)
})

test('substring match is case-insensitive (chains shouldnt fail on header casing)', () => {
  const chain = {
    id: 'case', name: 'c', severity: 'Low',
    steps: [{ step_id: 1, description: 'fetch', curl: 'curl -i https://example.com', expected_result: 'CONTENT-TYPE' }],
  }
  const r = cv.verifyChain(chain)
  assert.strictEqual(r.verified, true, 'case-insensitive substring match should pass')
})

test('regex match respects explicit case sensitivity', () => {
  // Lowercase `/example domain/` with no i-flag → match example.com body exactly.
  // Real page has "Example Domain" (capital). Without i-flag, should NOT match.
  const chain = {
    id: 're-case', name: 'r', severity: 'Low',
    steps: [{ step_id: 1, description: 'fetch', curl: 'curl -s https://example.com', expected_result: '/example domain/' }],
  }
  const r = cv.verifyChain(chain)
  assert.strictEqual(r.verified, false, 'case-sensitive regex should NOT match "Example Domain"')
})

test('match_failure diagnostic captures response preview', () => {
  const chain = {
    id: 'diag', name: 'd', severity: 'Low',
    steps: [{ step_id: 1, description: 'fetch', curl: 'curl -s https://example.com', expected_result: 'DefinitelyNotInResponse' }],
  }
  const r = cv.verifyChain(chain)
  assert.strictEqual(r.verified, false)
  assert.ok(r.stepResults[0].match_failure, 'should populate match_failure diagnostic')
  assert.ok(r.stepResults[0].match_failure.expected.includes('DefinitelyNotInResponse'))
  assert.ok(r.stepResults[0].match_failure.responsePreview.length > 0)
})

test('stderr captured in stepRecord when present', () => {
  // `-v` writes to stderr; we shouldn't choke on that.
  const chain = {
    id: 'stderr', name: 's', severity: 'Low',
    steps: [{ step_id: 1, description: 'verbose', curl: 'curl -v https://example.com', expected_result: 'HTTP 200' }],
  }
  const r = cv.verifyChain(chain)
  assert.strictEqual(r.verified, true)
  // -v output goes to stderr; our stderr field should capture some of it
  assert.ok(r.stepResults[0].stderr || r.stepResults[0].response, 'should capture something useful')
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
