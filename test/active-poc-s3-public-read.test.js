// test/active-poc-s3-public-read.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const probe = require('../agents/active-poc-library/cloud-security/s3-public-read')

test('exports metadata', () => {
  assert.strictEqual(probe.name, 's3-public-read')
  assert.strictEqual(probe.squad, 'cloud-security')
  assert.strictEqual(probe.max_attempts, 1)
})

test('single GET captures response', async () => {
  let calls = 0
  const fakeFetch = async () => {
    calls++
    return { status: 200, body: 'public-content', headers: { 'content-type': 'text/plain' } }
  }
  const r = await probe.run(
    { id: 'F-1', url: 'https://my-bucket.s3.amazonaws.com/secret.txt' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(calls, 1)
  assert.strictEqual(r.public_readable, true)
})

test('skips non-S3 URL', async () => {
  const r = await probe.run(
    { id: 'F-1', url: 'https://example.com/foo' },
    { fetchImpl: async () => { throw new Error('should not fetch') } },
  )
  assert.strictEqual(r.skipped, true)
})

test('aborts on AccessDenied / 403', async () => {
  const fakeFetch = async () => ({ status: 403,
    body: '<Error><Code>AccessDenied</Code></Error>', headers: {} })
  const r = await probe.run(
    { id: 'F-1', url: 'https://my-bucket.s3.amazonaws.com/x' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(r.public_readable, false)
})
