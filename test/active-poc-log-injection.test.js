// test/active-poc-log-injection.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const probe = require('../agents/active-poc-library/pentest/unauth-log-injection')

test('exports metadata', () => {
  assert.strictEqual(probe.name, 'unauth-log-injection')
  assert.strictEqual(probe.squad, 'pentest')
  assert.strictEqual(probe.max_attempts, 2)
})

test('sends exactly 2 marker-tagged POSTs, captures requestIds', async () => {
  let calls = 0
  const fakeFetch = async () => {
    calls++
    return { status: 200,
      body: `{"requestId":"r${calls}","status":200,"info":"Success"}`, headers: {} }
  }
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/api/v1/chatLog/sync' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(calls, 2)
  assert.strictEqual(r.request_ids.length, 2)
  assert.ok(r.request_ids.includes('r1'))
  assert.ok(r.request_ids.includes('r2'))
})

test('proven_injection=true when both writes return distinct requestIds', async () => {
  let c = 0
  const fakeFetch = async () => {
    c++
    return { status: 200, body: `{"requestId":"id-${c}"}`, headers: {} }
  }
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/api/v1/chatLog/sync' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(r.proven_injection, true)
})
