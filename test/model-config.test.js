const assert = require('node:assert')
const { test } = require('node:test')
const modelConfig = require('../agents/model-config')

test('PROFILES.default exists (empty = no overrides)', () => {
  assert.ok(modelConfig.PROFILES.default, 'default profile present')
  assert.strictEqual(Object.keys(modelConfig.PROFILES.default).length, 0,
    'default profile is empty (no overrides — uses modelRouter)')
})

test('PROFILES.G4_test_sonnet swaps krishna to Sonnet', () => {
  assert.strictEqual(modelConfig.PROFILES.G4_test_sonnet.krishna, 'claude-sonnet-4-6')
})

test('getProfileOverride returns null for default profile (no overrides)', () => {
  assert.strictEqual(modelConfig.getProfileOverride('KRISHNA', 'default'), null)
  assert.strictEqual(modelConfig.getProfileOverride('DHARMA', 'default'), null)
})

test('getProfileOverride returns Sonnet for KRISHNA under G4_test_sonnet', () => {
  assert.strictEqual(
    modelConfig.getProfileOverride('KRISHNA', 'G4_test_sonnet'),
    'claude-sonnet-4-6'
  )
})

test('getProfileOverride is case-insensitive on agent name', () => {
  assert.strictEqual(
    modelConfig.getProfileOverride('krishna', 'G4_test_sonnet'),
    'claude-sonnet-4-6'
  )
  assert.strictEqual(
    modelConfig.getProfileOverride('Krishna', 'G4_test_sonnet'),
    'claude-sonnet-4-6'
  )
})

test('getProfileOverride returns null for non-Krishna agents under G4_test_sonnet', () => {
  // G4_test_sonnet only overrides KRISHNA — other agents fall through
  assert.strictEqual(modelConfig.getProfileOverride('DHARMA', 'G4_test_sonnet'), null)
  assert.strictEqual(modelConfig.getProfileOverride('VYASA', 'G4_test_sonnet'), null)
})

test('getProfileOverride reads MODEL_PROFILE env var when no profile arg passed', () => {
  const orig = process.env.MODEL_PROFILE
  try {
    process.env.MODEL_PROFILE = 'G4_test_sonnet'
    assert.strictEqual(modelConfig.getProfileOverride('KRISHNA'), 'claude-sonnet-4-6')
    process.env.MODEL_PROFILE = 'default'
    assert.strictEqual(modelConfig.getProfileOverride('KRISHNA'), null)
  } finally {
    if (orig === undefined) delete process.env.MODEL_PROFILE
    else process.env.MODEL_PROFILE = orig
  }
})

test('getProfileOverride falls through (returns null) for unknown profile', () => {
  // Invalid MODEL_PROFILE shouldn't crash — return null, let modelRouter handle
  assert.strictEqual(modelConfig.getProfileOverride('KRISHNA', 'nonexistent_profile'), null)
})

test('PROFILES is frozen — mutation does not take effect', () => {
  // In non-strict mode, mutation silently fails. Verify behavior, not error mechanism.
  const before = JSON.stringify(modelConfig.PROFILES.G4_test_sonnet)
  try { modelConfig.PROFILES.G4_test_sonnet.dharma = 'tampered' } catch {}
  const after = JSON.stringify(modelConfig.PROFILES.G4_test_sonnet)
  assert.strictEqual(after, before, 'frozen object resists mutation')
})
