// test/active-poc-vpn-no-lockout.test.js
// VPN no-lockout probe — max 5 obvious-fake attempts, captures uniformity.

const assert = require('node:assert')
const { test } = require('node:test')
const probe = require('../agents/active-poc-library/pentest/vpn-no-lockout')

test('exports correct metadata', () => {
  assert.strictEqual(probe.name, 'vpn-no-lockout')
  assert.strictEqual(probe.targets_capability, 'vpn-no-lockout')
  assert.strictEqual(probe.squad, 'pentest')
  assert.ok(probe.max_attempts <= 5)
})

test('runs 5 attempts, captures uniformity', async () => {
  let count = 0
  const fakeFetch = async () => { count++; return { status: 200, body: 'a0=8', headers: {} } }
  const r = await probe.run(
    { id: 'F-1', url: 'https://webvpn.example.com/+webvpn+/index.html' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(count, 5)
  assert.strictEqual(r.attempts.length, 5)
  assert.strictEqual(r.no_lockout_proven, true)
})

test('aborts on defender response mid-loop', async () => {
  let count = 0
  const fakeFetch = async () => {
    count++
    return count === 3 ? { status: 429, body: '', headers: {} } : { status: 200, body: 'a0=8', headers: {} }
  }
  const r = await probe.run(
    { id: 'F-1', url: 'https://webvpn.example.com/+webvpn+/index.html' },
    { fetchImpl: fakeFetch },
  )
  assert.strictEqual(r.aborted_on_defender, true)
  assert.ok(r.attempts.length <= 3)
})

test('refuses URL outside VPN pattern (defense-in-depth)', async () => {
  const r = await probe.run(
    { id: 'F-1', url: 'https://random-site.com/x' },
    { fetchImpl: async () => { throw new Error('should not fetch') } },
  )
  assert.strictEqual(r.skipped, true)
  assert.match(r.skip_reason, /pattern/)
})
