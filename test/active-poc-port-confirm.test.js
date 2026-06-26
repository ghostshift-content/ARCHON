// test/active-poc-port-confirm.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const probe = require('../agents/active-poc-library/network-pentest/port-confirm')

test('exports metadata', () => {
  assert.strictEqual(probe.name, 'port-confirm')
  assert.strictEqual(probe.squad, 'network-pentest')
})

test('extracts host:port from finding', async () => {
  const r = await probe.run(
    { id: 'F-1', url: 'http://10.0.0.5:8080/admin' },
    { connectImpl: async (h, p) => ({ ok: true, host: h, port: p }) },
  )
  assert.strictEqual(r.host, '10.0.0.5')
  assert.strictEqual(r.port, 8080)
  assert.strictEqual(r.reachable, true)
})

test('returns reachable=false on connect failure', async () => {
  const r = await probe.run(
    { id: 'F-1', url: 'http://10.0.0.5:8080' },
    { connectImpl: async () => ({ ok: false, error: 'ECONNREFUSED' }) },
  )
  assert.strictEqual(r.reachable, false)
})

test('defaults port to 80/443 from scheme when not in URL', async () => {
  const r1 = await probe.run(
    { id: 'F-1', url: 'http://example.com/x' },
    { connectImpl: async () => ({ ok: true }) },
  )
  assert.strictEqual(r1.port, 80)

  const r2 = await probe.run(
    { id: 'F-1', url: 'https://example.com/x' },
    { connectImpl: async () => ({ ok: true }) },
  )
  assert.strictEqual(r2.port, 443)
})
