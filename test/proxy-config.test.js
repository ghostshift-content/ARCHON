// test/proxy-config.test.js
//
// Unit tests for src/integrations/proxy-config.js — Burp Suite / ZAP /
// mitmproxy support. Covers config resolution, the env merged into spawned
// subprocesses, the Playwright option shape, and curl arg augmentation.

const assert = require('node:assert')
const { test, beforeEach, afterEach } = require('node:test')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROXY_ENV_KEYS = [
  'ARCHON_PROXY_URL', 'ARCHON_PROXY_ENABLED', 'ARCHON_PROXY_BYPASS',
  'ARCHON_PROXY_CA_CERT', 'ARCHON_PROXY_INSECURE',
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
]

let _saved = {}

beforeEach(() => {
  _saved = {}
  for (const k of PROXY_ENV_KEYS) { _saved[k] = process.env[k]; delete process.env[k] }
  delete require.cache[require.resolve('../src/integrations/proxy-config')]
})

afterEach(() => {
  for (const k of PROXY_ENV_KEYS) {
    if (_saved[k] === undefined) delete process.env[k]; else process.env[k] = _saved[k]
  }
  delete require.cache[require.resolve('../src/integrations/proxy-config')]
})

test('disabled by default — no env vars set', () => {
  const pc = require('../src/integrations/proxy-config')
  const cfg = pc.getProxyConfig()
  assert.strictEqual(cfg.enabled, false)
  assert.deepStrictEqual(pc.getProxyEnv(), {})
  assert.strictEqual(pc.getPlaywrightProxyOption(), undefined)
  assert.deepStrictEqual(pc.getCurlProxyArgs(), [])
})

test('ARCHON_PROXY_URL alone enables proxying (Burp default listener)', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  const pc = require('../src/integrations/proxy-config')
  const cfg = pc.getProxyConfig()
  assert.strictEqual(cfg.enabled, true)
  assert.strictEqual(cfg.url, 'http://127.0.0.1:8080')
})

test('falls back to standard HTTPS_PROXY/HTTP_PROXY when ARCHON_PROXY_URL unset', () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9090'
  const pc = require('../src/integrations/proxy-config')
  const cfg = pc.getProxyConfig()
  assert.strictEqual(cfg.enabled, true)
  assert.strictEqual(cfg.url, 'http://127.0.0.1:9090')
})

test('ARCHON_PROXY_ENABLED=0 forces disabled even with a URL present', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  process.env.ARCHON_PROXY_ENABLED = '0'
  const pc = require('../src/integrations/proxy-config')
  assert.strictEqual(pc.getProxyConfig().enabled, false)
  assert.deepStrictEqual(pc.getProxyEnv(), {})
})

test('ARCHON_PROXY_ENABLED=1 with no URL throws a clear error', () => {
  process.env.ARCHON_PROXY_ENABLED = '1'
  const pc = require('../src/integrations/proxy-config')
  assert.throws(() => pc.getProxyConfig(), /no proxy URL was found/)
})

test('getProxyEnv() sets both-case HTTP(S)_PROXY and always bypasses loopback', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  const pc = require('../src/integrations/proxy-config')
  const env = pc.getProxyEnv()
  assert.strictEqual(env.HTTP_PROXY, 'http://127.0.0.1:8080')
  assert.strictEqual(env.http_proxy, 'http://127.0.0.1:8080')
  assert.strictEqual(env.HTTPS_PROXY, 'http://127.0.0.1:8080')
  assert.strictEqual(env.https_proxy, 'http://127.0.0.1:8080')
  assert.ok(env.NO_PROXY.includes('localhost'))
  assert.ok(env.NO_PROXY.includes('127.0.0.1'))
  assert.ok(!('NODE_EXTRA_CA_CERTS' in env))
  assert.ok(!('NODE_TLS_REJECT_UNAUTHORIZED' in env))
})

test('ARCHON_PROXY_BYPASS entries are merged in addition to the always-bypassed loopback hosts', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  process.env.ARCHON_PROXY_BYPASS = '*.internal, 10.0.0.0/8'
  const pc = require('../src/integrations/proxy-config')
  const env = pc.getProxyEnv()
  assert.ok(env.NO_PROXY.includes('*.internal'))
  assert.ok(env.NO_PROXY.includes('10.0.0.0/8'))
  assert.ok(env.NO_PROXY.includes('localhost'))
})

test('ARCHON_PROXY_CA_CERT forwards NODE_EXTRA_CA_CERTS and a curl --cacert flag', () => {
  const tmp = path.join(os.tmpdir(), `archon-test-ca-${process.pid}.pem`)
  fs.writeFileSync(tmp, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n')
  try {
    process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
    process.env.ARCHON_PROXY_CA_CERT = tmp
    const pc = require('../src/integrations/proxy-config')
    const env = pc.getProxyEnv()
    assert.strictEqual(env.NODE_EXTRA_CA_CERTS, tmp)
    assert.deepStrictEqual(pc.getCurlProxyArgs(), ['--cacert', tmp])
  } finally {
    fs.unlinkSync(tmp)
  }
})

test('ARCHON_PROXY_CA_CERT pointing at a missing file throws', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  process.env.ARCHON_PROXY_CA_CERT = '/definitely/does/not/exist.pem'
  const pc = require('../src/integrations/proxy-config')
  assert.throws(() => pc.getProxyConfig(), /missing file/)
})

test('ARCHON_PROXY_INSECURE forwards NODE_TLS_REJECT_UNAUTHORIZED=0 and curl --insecure', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  process.env.ARCHON_PROXY_INSECURE = '1'
  const pc = require('../src/integrations/proxy-config')
  const env = pc.getProxyEnv()
  assert.strictEqual(env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
  assert.deepStrictEqual(pc.getCurlProxyArgs(), ['--insecure'])
})

test('getPlaywrightProxyOption() returns the {server, bypass} shape Playwright expects', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  const pc = require('../src/integrations/proxy-config')
  const opt = pc.getPlaywrightProxyOption()
  assert.strictEqual(opt.server, 'http://127.0.0.1:8080')
  assert.ok(opt.bypass.includes('localhost'))
})

test('buildSpawnEnv merges proxy env when configured — reaches agent-spawned subprocesses', () => {
  process.env.ARCHON_PROXY_URL = 'http://127.0.0.1:8080'
  delete require.cache[require.resolve('../agents/runner/adapters/common')]
  const { buildSpawnEnv } = require('../agents/runner/adapters/common')
  const env = buildSpawnEnv({})
  assert.strictEqual(env.HTTPS_PROXY, 'http://127.0.0.1:8080')
  assert.strictEqual(env.HTTP_PROXY, 'http://127.0.0.1:8080')
  delete require.cache[require.resolve('../agents/runner/adapters/common')]
})

test('buildSpawnEnv injects no proxy keys when proxying is disabled (default, unchanged behavior)', () => {
  delete require.cache[require.resolve('../agents/runner/adapters/common')]
  const { buildSpawnEnv } = require('../agents/runner/adapters/common')
  const env = buildSpawnEnv({})
  assert.ok(!('HTTP_PROXY' in env))
  assert.ok(!('HTTPS_PROXY' in env))
  assert.ok(!('NO_PROXY' in env))
  delete require.cache[require.resolve('../agents/runner/adapters/common')]
})
