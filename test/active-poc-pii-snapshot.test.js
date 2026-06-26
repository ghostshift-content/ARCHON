// test/active-poc-pii-snapshot.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const probe = require('../agents/active-poc-library/pentest/pii-endpoint-snapshot')

test('exports metadata', () => {
  assert.strictEqual(probe.name, 'pii-endpoint-snapshot')
  assert.strictEqual(probe.squad, 'pentest')
  assert.ok(probe.max_attempts <= 3)
})

test('3 parametrized variants captured', async () => {
  const calls = []
  const fakeFetch = async (url) => { calls.push(url); return { status: 200, body: `body-${url}`, headers: {} } }
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/loginADFS.json' },
    { fetchImpl: fakeFetch },
  )
  assert.ok(calls.length <= 3)
  assert.ok(r.variants.length >= 1)
})

test('detects PII keys in response body', async () => {
  const fakeFetch = async () => ({ status: 200,
    body: '{"email":"alice@example.com","itCode":"abc"}', headers: {} })
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/loginADFS.json' },
    { fetchImpl: fakeFetch },
  )
  assert.ok(r.pii_keys_detected.length >= 1)
})

test('aborts on 403 / WAF', async () => {
  let calls = 0
  const fakeFetch = async () => { calls++; return { status: 403, body: '', headers: { 'cf-mitigated': 'challenge' } } }
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/x.json' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(r.aborted_on_defender, true)
  assert.ok(calls <= 2)
})
