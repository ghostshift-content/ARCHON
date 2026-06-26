#!/usr/bin/env node
// Unit tests for /root/agents/anthropic-key.js
// Run: node /root/agents/test/anthropic-key.test.js

const assert = require('assert')
const fs = require('fs')
const ak = require('../src/integrations/anthropic-key')

const CFG = ak.CONFIG_PATH
const BACKUP = CFG + '.test-backup'

// Save real config if exists, always restore
const realExists = fs.existsSync(CFG)
if (realExists) fs.copyFileSync(CFG, BACKUP)
let restored = false
function restore() {
  if (restored) return
  restored = true
  try {
    if (fs.existsSync(CFG)) fs.unlinkSync(CFG)
    if (realExists && fs.existsSync(BACKUP)) {
      fs.copyFileSync(BACKUP, CFG)
      fs.unlinkSync(BACKUP)
    }
  } catch {}
  ak.resetCache()
  delete process.env.ANTHROPIC_API_KEY
}
process.on('exit', restore)
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1) })

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

console.log('anthropic-key tests:')

// Start clean — no env, no config file
delete process.env.ANTHROPIC_API_KEY
if (fs.existsSync(CFG)) fs.unlinkSync(CFG)
ak.resetCache()

test('no key → source is oauth', () => {
  assert.strictEqual(ak.keySource(), 'oauth')
  assert.strictEqual(ak.isKeyConfigured(), false)
  assert.strictEqual(ak.getAnthropicApiKey(), null)
})

test('setAnthropicApiKey validates prefix', () => {
  assert.throws(() => ak.setAnthropicApiKey('invalid-key'), /must start with sk-ant-/)
  assert.throws(() => ak.setAnthropicApiKey(''), /must be a non-empty string/)
  assert.throws(() => ak.setAnthropicApiKey(null), /must be a non-empty string/)
})

test('setAnthropicApiKey with valid key persists + mode 600', () => {
  const fakeKey = 'sk-ant-test-' + 'x'.repeat(80)
  ak.setAnthropicApiKey(fakeKey)
  assert.ok(fs.existsSync(CFG))
  const stat = fs.statSync(CFG)
  assert.strictEqual(stat.mode & 0o777, 0o600, `expected mode 600, got ${(stat.mode & 0o777).toString(8)}`)
  assert.strictEqual(ak.keySource(), 'config')
  assert.strictEqual(ak.getAnthropicApiKey(), fakeKey)
})

test('env var overrides config file', () => {
  const envKey = 'sk-ant-env-' + 'y'.repeat(80)
  process.env.ANTHROPIC_API_KEY = envKey
  ak.resetCache()
  assert.strictEqual(ak.keySource(), 'env')
  assert.strictEqual(ak.getAnthropicApiKey(), envKey)
  delete process.env.ANTHROPIC_API_KEY
  ak.resetCache()
})

test('clearAnthropicApiKey removes config file', () => {
  assert.ok(fs.existsSync(CFG), 'config should exist before clear')
  ak.clearAnthropicApiKey()
  assert.strictEqual(fs.existsSync(CFG), false)
  assert.strictEqual(ak.keySource(), 'oauth')
})

test('mtime cache invalidation works', () => {
  const k1 = 'sk-ant-v1-' + 'a'.repeat(80)
  const k2 = 'sk-ant-v2-' + 'b'.repeat(80)
  ak.setAnthropicApiKey(k1)
  assert.strictEqual(ak.getAnthropicApiKey(), k1)
  // Simulate UI changing the key
  ak.setAnthropicApiKey(k2)
  assert.strictEqual(ak.getAnthropicApiKey(), k2)
})

console.log(`\n${passed} passed, ${failures} failed`)
restore()
process.exit(failures > 0 ? 1 : 0)
