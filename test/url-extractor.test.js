#!/usr/bin/env node
// Unit tests for /root/agents/url-extractor.js
// Run: bun test test/url-extractor.test.js

const assert = require('assert')
const { extractTargetUrl } = require('../src/utils/url-extractor')

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

console.log('url-extractor tests:')

test('extracts https:// from title (regression: pentest #1 msi.emiratesnbd.com)', () => {
  const out = extractTargetUrl({ taskTitle: 'Pentest H1-ENBD — https://msi.emiratesnbd.com (ATLAS full pipeline)' })
  assert.strictEqual(out, 'https://msi.emiratesnbd.com')
})

test('https:// in goal beats bare-domain in title (Gap 2 fix)', () => {
  const out = extractTargetUrl({
    taskTitle: 'Pentest H1-ENBD — politemail-read.emiratesnbd.com (ATLAS full pipeline)',
    goal: 'Web application pentest of https://politemail-read.emiratesnbd.com — full surface',
  })
  assert.strictEqual(out, 'https://politemail-read.emiratesnbd.com')
})

test('bare domain falls back to https:// (no longer http://)', () => {
  const out = extractTargetUrl({ taskTitle: 'Pentest of example.com', goal: 'just a bare domain' })
  assert.strictEqual(out, 'https://example.com')
})

test('explicit http:// is preserved (rare HTTP-only targets)', () => {
  const out = extractTargetUrl({ goal: 'CTF target at http://lab.local' })
  assert.strictEqual(out, 'http://lab.local')
})

test('returns null when no URL anywhere', () => {
  const out = extractTargetUrl({ taskTitle: 'Generic task', goal: 'no url here' })
  assert.strictEqual(out, null)
})

test('strips trailing comma', () => {
  const out = extractTargetUrl({ goal: 'See https://example.com, then probe deeper' })
  assert.strictEqual(out, 'https://example.com')
})

test('strips trailing paren and period', () => {
  const out = extractTargetUrl({ goal: 'Visit (https://example.com).' })
  assert.strictEqual(out, 'https://example.com')
})

test('first scheme match wins when multiple URLs present', () => {
  const out = extractTargetUrl({
    taskTitle: 'Compare https://primary.com to https://secondary.com',
  })
  assert.strictEqual(out, 'https://primary.com')
})

test('email-style strings do NOT pollute scheme match', () => {
  const out = extractTargetUrl({
    goal: 'Contact vdp@emiratesnbd.com — also test https://politemail-read.emiratesnbd.com',
  })
  assert.strictEqual(out, 'https://politemail-read.emiratesnbd.com')
})

test('uses dispatch.title alias when taskTitle absent', () => {
  const out = extractTargetUrl({ title: 'https://aliased.com' })
  assert.strictEqual(out, 'https://aliased.com')
})

test('handles missing fields gracefully', () => {
  assert.strictEqual(extractTargetUrl(null), null)
  assert.strictEqual(extractTargetUrl(undefined), null)
  assert.strictEqual(extractTargetUrl({}), null)
})

test('UAE/SA TLDs supported for ENBD-class targets', () => {
  const out = extractTargetUrl({ goal: 'target is bank.ae' })
  assert.strictEqual(out, 'https://bank.ae')
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
