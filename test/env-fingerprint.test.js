// test/env-fingerprint.test.js
//
// Stage 0.6 fingerprint normalizer: parse the LLM's JSON (even fenced/prose-wrapped),
// coerce to the stable shape, and fail soft to an empty-but-valid fingerprint.

const assert = require('node:assert')
const { test } = require('node:test')
const { normalizeFingerprint, buildFingerprintPrompt, fingerprintSummary } = require('../src/pipeline/env-fingerprint')

test('parses a clean JSON object', () => {
  const fp = normalizeFingerprint('{"product":"Adobe AEM","version":"6.5","frameworks":["Sling"],"server":"Apache","waf":{"present":true,"vendor":"Akamai"},"notable_paths":["/crx/"],"cve_candidates":["CVE-2024-x"],"confidence":"high"}')
  assert.strictEqual(fp.product, 'Adobe AEM')
  assert.strictEqual(fp.version, '6.5')
  assert.deepStrictEqual(fp.frameworks, ['Sling'])
  assert.strictEqual(fp.waf.present, true)
  assert.strictEqual(fp.waf.vendor, 'Akamai')
  assert.strictEqual(fp.confidence, 'high')
})

test('extracts JSON from prose/fence-wrapped output', () => {
  const fp = normalizeFingerprint('Here is the fingerprint:\n```json\n{"product":"WordPress","waf":{"present":false}}\n```\nDone.')
  assert.strictEqual(fp.product, 'WordPress')
  assert.strictEqual(fp.waf.present, false)
})

test('fails soft on garbage → empty-but-valid shape', () => {
  for (const bad of [null, undefined, '', 'no json here', '{broken', 42]) {
    const fp = normalizeFingerprint(bad)
    assert.strictEqual(fp.product, '')
    assert.deepStrictEqual(fp.frameworks, [])
    assert.strictEqual(fp.waf.present, false)
    assert.strictEqual(fp.confidence, 'low')
  }
})

test('coerces wrong types + caps arrays', () => {
  const fp = normalizeFingerprint({ product: 123, frameworks: 'nope', waf: 'detected — Cloudflare', notable_paths: Array(50).fill('/x'), confidence: 'BOGUS' })
  assert.strictEqual(fp.product, '123')
  assert.deepStrictEqual(fp.frameworks, [])         // non-array → []
  assert.strictEqual(fp.waf.present, false)         // waf must be an object; string → not present
  assert.ok(fp.notable_paths.length <= 25)          // capped
  assert.strictEqual(fp.confidence, 'low')          // invalid → low
})

test('waf.present accepts a "detected" string', () => {
  const fp = normalizeFingerprint({ waf: { present: 'detected', vendor: 'Imperva' } })
  assert.strictEqual(fp.waf.present, true)
  assert.strictEqual(fp.waf.vendor, 'Imperva')
})

test('fingerprintSummary is empty when nothing identified, populated otherwise', () => {
  assert.strictEqual(fingerprintSummary(normalizeFingerprint(null)), '')
  const s = fingerprintSummary(normalizeFingerprint({ product: 'AEM', waf: { present: true, vendor: 'Akamai' } }))
  assert.match(s, /AEM/)
  assert.match(s, /Akamai/)
})

test('prompt includes the target + WAF status', () => {
  const p = buildFingerprintPrompt({ targetUrl: 'https://x.test', wafStatus: 'detected — Cloudflare', techStack: 'java' })
  assert.match(p, /https:\/\/x\.test/)
  assert.match(p, /Cloudflare/)
  assert.match(p, /ONE JSON object/)
})
