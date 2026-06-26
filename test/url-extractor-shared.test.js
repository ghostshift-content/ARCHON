// test/url-extractor-shared.test.js
//
// Unit tests for the shared agents/url-extractor.js module (extractFirstUrl).
//
// NOTE: a DIFFERENT module already exists at the top-level /root/agents/url-extractor.js
// (exports `extractTargetUrl({dispatch})` — for Phase 3.06 scope routing). The new
// shared extractor at agents/url-extractor.js has a different API: it takes a raw
// text string and returns the first http(s) URL with trailing punctuation trimmed.
// Used by kripa-validated-builder (producer) + scope-validator (consumer fallback).
//
// Run: bun test test/url-extractor-shared.test.js

const test = require('node:test')
const assert = require('node:assert')
const { extractFirstUrl } = require('../agents/url-extractor')

test('extractFirstUrl: returns URL when present in text', () => {
  assert.strictEqual(
    extractFirstUrl('curl -sI https://uatcommercial.lenovo.com/eticket/login'),
    'https://uatcommercial.lenovo.com/eticket/login'
  )
})

test('extractFirstUrl: returns first URL when multiple present', () => {
  assert.strictEqual(
    extractFirstUrl('See https://a.example.com/x and https://b.example.com/y'),
    'https://a.example.com/x'
  )
})

test('extractFirstUrl: handles http (not just https)', () => {
  assert.strictEqual(
    extractFirstUrl('Attacker page at http://evil.test/payload'),
    'http://evil.test/payload'
  )
})

test('extractFirstUrl: returns empty string when no URL', () => {
  assert.strictEqual(extractFirstUrl('no url here, just words'), '')
})

test('extractFirstUrl: returns empty for null/undefined/non-string', () => {
  assert.strictEqual(extractFirstUrl(null), '')
  assert.strictEqual(extractFirstUrl(undefined), '')
  assert.strictEqual(extractFirstUrl(42), '')
  assert.strictEqual(extractFirstUrl({}), '')
})

test('extractFirstUrl: stops at whitespace, quotes, backticks', () => {
  assert.strictEqual(
    extractFirstUrl('`https://example.com/path` was tested'),
    'https://example.com/path'
  )
  assert.strictEqual(
    extractFirstUrl('"https://quoted.test/api" returned 500'),
    'https://quoted.test/api'
  )
})

test('extractFirstUrl: trims trailing punctuation (. , ; : ) ])', () => {
  assert.strictEqual(extractFirstUrl('See https://example.com/a.'), 'https://example.com/a')
  assert.strictEqual(extractFirstUrl('Visit https://example.com/b,'), 'https://example.com/b')
  assert.strictEqual(extractFirstUrl('(https://example.com/c)'), 'https://example.com/c')
})

test('extractFirstUrl: KRIPA-realistic detail text', () => {
  const detail = `Confirmed via curl: curl -sI 'https://uatcommercial.lenovo.com/eticket/login' returned 200 with X-Powered-By header.`
  assert.strictEqual(extractFirstUrl(detail), 'https://uatcommercial.lenovo.com/eticket/login')
})
