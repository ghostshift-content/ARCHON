// test/active-poc-csrf-bypass.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const probe = require('../agents/active-poc-library/pentest/csrf-bypass-confirm')

test('exports correct metadata', () => {
  assert.strictEqual(probe.name, 'csrf-bypass-confirm')
  assert.strictEqual(probe.squad, 'pentest')
  assert.strictEqual(probe.max_attempts, 2)
})

test('sends 1 cookieless + 1 cookied, compares responses', async () => {
  let calls = 0
  const fakeFetch = async (url, opts) => {
    calls++
    const hasCookie = opts.headers && opts.headers.Cookie
    return { status: 200, body: hasCookie ? 'authed' : 'unauthed', headers: {} }
  }
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/api/x' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(calls, 2)
  assert.strictEqual(r.csrf_bypass_proven, false)
})

test('csrf_bypass_proven=true when responses identical', async () => {
  const fakeFetch = async () => ({ status: 200, body: 'IDENTICAL', headers: {} })
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/api/x' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(r.csrf_bypass_proven, true)
})
