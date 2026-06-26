
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
const test = require('node:test')
const assert = require('node:assert')

test('GATE-89: chain-verifier imports redirect-aware-curl', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/src/pipeline/chain-verifier.js'), 'utf8')
  assert.match(src, /require\([^)]*redirect-aware-curl[^)]*\)/,
    'chain-verifier must import redirect-aware-curl')
})

test('GATE-89: redirect-aware-curl exports both helpers', () => {
  const m = require('../agents/redirect-aware-curl')
  assert.strictEqual(typeof m.isCorsAssertion, 'function')
  assert.strictEqual(typeof m.extractFinalResponse, 'function')
})

test('GATE-89: isCorsAssertion detects all 5 CORS header keywords', () => {
  const { isCorsAssertion } = require('../agents/redirect-aware-curl')
  for (const h of [
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
  ]) {
    assert.strictEqual(isCorsAssertion(h), true, `must detect ${h}`)
  }
})

test('GATE-89: extractFinalResponse strips redirect-hop headers', () => {
  const { extractFinalResponse } = require('../agents/redirect-aware-curl')
  const raw = 'HTTP/1.1 301 Moved Permanently\naccess-control-allow-origin: https://evil.com\n\nHTTP/1.1 200 OK\ncontent-length: 2\n\nok\nHTTP/STATUS/200'
  const final = extractFinalResponse(raw)
  assert.match(final, /200 OK/)
  assert.doesNotMatch(final, /access-control-allow-origin/i)
})
