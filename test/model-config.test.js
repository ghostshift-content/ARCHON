const assert = require('node:assert')
const { test } = require('node:test')
const modelConfig = require('../agents/model-config')

test('PROFILES.default exists (empty = no overrides)', () => {
  assert.ok(modelConfig.PROFILES.default, 'default profile present')
  assert.strictEqual(Object.keys(modelConfig.PROFILES.default).length, 0,
    'default profile is empty (no overrides — uses modelRouter)')
})

test('PROFILES.G4_test_sonnet swaps atlas to Sonnet', () => {
  assert.strictEqual(modelConfig.PROFILES.G4_test_sonnet.atlas, 'claude-sonnet-4-6')
})

test('getProfileOverride returns null for default profile (no overrides)', () => {
  assert.strictEqual(modelConfig.getProfileOverride('ATLAS', 'default'), null)
  assert.strictEqual(modelConfig.getProfileOverride('SENTRY', 'default'), null)
})

test('getProfileOverride returns Sonnet for ATLAS under G4_test_sonnet', () => {
  assert.strictEqual(
    modelConfig.getProfileOverride('ATLAS', 'G4_test_sonnet'),
    'claude-sonnet-4-6'
  )
})

test('getProfileOverride is case-insensitive on agent name', () => {
  assert.strictEqual(
    modelConfig.getProfileOverride('atlas', 'G4_test_sonnet'),
    'claude-sonnet-4-6'
  )
  assert.strictEqual(
    modelConfig.getProfileOverride('Atlas', 'G4_test_sonnet'),
    'claude-sonnet-4-6'
  )
})

test('getProfileOverride returns null for non-Atlas agents under G4_test_sonnet', () => {
  // G4_test_sonnet only overrides ATLAS — other agents fall through
  assert.strictEqual(modelConfig.getProfileOverride('SENTRY', 'G4_test_sonnet'), null)
  assert.strictEqual(modelConfig.getProfileOverride('SCRIBE', 'G4_test_sonnet'), null)
})

test('getProfileOverride reads MODEL_PROFILE env var when no profile arg passed', () => {
  const orig = process.env.MODEL_PROFILE
  try {
    process.env.MODEL_PROFILE = 'G4_test_sonnet'
    assert.strictEqual(modelConfig.getProfileOverride('ATLAS'), 'claude-sonnet-4-6')
    process.env.MODEL_PROFILE = 'default'
    assert.strictEqual(modelConfig.getProfileOverride('ATLAS'), null)
  } finally {
    if (orig === undefined) delete process.env.MODEL_PROFILE
    else process.env.MODEL_PROFILE = orig
  }
})

test('getProfileOverride falls through (returns null) for unknown profile', () => {
  // Invalid MODEL_PROFILE shouldn't crash — return null, let modelRouter handle
  assert.strictEqual(modelConfig.getProfileOverride('ATLAS', 'nonexistent_profile'), null)
})

test('PROFILES is frozen — mutation does not take effect', () => {
  // In non-strict mode, mutation silently fails. Verify behavior, not error mechanism.
  const before = JSON.stringify(modelConfig.PROFILES.G4_test_sonnet)
  try { modelConfig.PROFILES.G4_test_sonnet.sentry = 'tampered' } catch {}
  const after = JSON.stringify(modelConfig.PROFILES.G4_test_sonnet)
  assert.strictEqual(after, before, 'frozen object resists mutation')
})
