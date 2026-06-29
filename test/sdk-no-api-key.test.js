// test/sdk-no-api-key.test.js
//
// ARCHON must run on the Claude SDK via subscription OAuth with NO API key.
// These assertions lock that in: the default adapter is the Agent SDK, the env
// builder never fabricates a key, and key discovery reports 'oauth' when none is
// configured. (A live end-to-end OAuth spawn is exercised manually / in e2e —
// here we keep it offline + deterministic.)

const assert = require('node:assert')
const { test } = require('node:test')

test('default runner adapter is the Agent SDK (not cli)', () => {
  const { resolvedAdapterName } = require('../agents/runner/agent-runner')
  const prev = process.env.ADAPTER
  delete process.env.ADAPTER
  try {
    assert.strictEqual(resolvedAdapterName({}), 'sdk', 'default adapter must be sdk')
    assert.strictEqual(resolvedAdapterName({ adapter: 'cli' }), 'cli', 'explicit cli override still honored')
  } finally {
    if (prev === undefined) delete process.env.ADAPTER; else process.env.ADAPTER = prev
  }
})

test('buildSpawnEnv injects NO ANTHROPIC_API_KEY when none is configured (OAuth path)', () => {
  const { buildSpawnEnv } = require('../agents/runner/adapters/common')
  const anthropicKey = require('../src/integrations/anthropic-key')
  const prev = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  anthropicKey.resetCache()
  try {
    const env = buildSpawnEnv({})
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'no key must be injected — the CLI/SDK falls back to OAuth (~/.claude)')
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev
    anthropicKey.resetCache()
  }
})

test('key discovery reports oauth when no key is set', () => {
  const anthropicKey = require('../src/integrations/anthropic-key')
  const prev = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  anthropicKey.resetCache()
  try {
    assert.strictEqual(anthropicKey.getAnthropicApiKey(), null, 'no key → null')
    assert.strictEqual(anthropicKey.keySource(), 'oauth', "source is 'oauth' with no key/config")
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev
    anthropicKey.resetCache()
  }
})

test('omitApiKey forces OAuth even if a key IS present (independent-judge semantics)', () => {
  const { buildSpawnEnv } = require('../agents/runner/adapters/common')
  const anthropicKey = require('../src/integrations/anthropic-key')
  const prev = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-deadbeef'
  anthropicKey.resetCache()
  try {
    const env = buildSpawnEnv({ omitApiKey: true })
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'omitApiKey must suppress the key → force OAuth')
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev
    anthropicKey.resetCache()
  }
})
